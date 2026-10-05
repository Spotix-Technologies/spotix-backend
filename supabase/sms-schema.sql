-- supabase/sms-schema.sql
--
-- Spotix Bulk SMS — run this once in the SAME Supabase project the email
-- campaigns schema (campaign-schema.sql) already lives in.
--
-- Credit model: SMS credits belong to the BOOKER (organizer), not to an event
-- — they are bought as a flat quantity and are billed per number sent. They
-- are completely separate from event_credits (email). Same
-- available / reserved / consumed accounting as email, mutated only through
-- the RPC functions below so every change is atomic and race-safe.
--
--   create campaign   -> available -N, reserved +N   (credits reserved)
--   admin rejects     -> reserved  -N, available +N  (credits returned)
--   admin delivers    -> reserved  -N, consumed  +N  (credits spent)

-- ─── sms_credits ─────────────────────────────────────────────────────────
create table if not exists sms_credits (
  organizer_id text primary key,
  available    integer not null default 0,
  reserved     integer not null default 0,
  consumed     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint sms_credits_non_negative check (available >= 0 and reserved >= 0 and consumed >= 0)
);

-- ─── sms_credit_transactions (immutable ledger) ──────────────────────────
create table if not exists sms_credit_transactions (
  id               uuid primary key default gen_random_uuid(),
  organizer_id     text not null,
  sms_campaign_id  uuid,
  type             text not null check (type in (
                     'purchase', 'reservation', 'reservation_release',
                     'delivery_consumption', 'manual_adjustment'
                   )),
  amount           integer not null, -- signed: +credit, -debit (to `available`)
  reference        text,
  reason           text,
  created_by       text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_sms_tx_organizer on sms_credit_transactions (organizer_id, created_at desc);
create index if not exists idx_sms_tx_campaign on sms_credit_transactions (sms_campaign_id);
-- A Paystack reference can only ever grant credits once, even if two
-- fulfilment paths (client verify + webhook) race.
create unique index if not exists uq_sms_tx_purchase_reference
  on sms_credit_transactions (reference) where type = 'purchase';

-- ─── sms_campaign ────────────────────────────────────────────────────────
-- Statuses: created -> approved | rejected -> delivered (approved only).
create table if not exists sms_campaign (
  id                  uuid primary key default gen_random_uuid(),
  organizer_id        text not null,
  organizer_email     text,
  organizer_username  text,
  event_id            text not null,
  event_name_snapshot text not null,
  name                text not null,
  message_text        text not null,
  recipient_count     integer not null check (recipient_count > 0),
  credits_reserved    integer not null check (credits_reserved > 0),
  numbers_file_path   text not null,  -- path inside the sms-campaigns bucket
  numbers_file_url    text not null,  -- url returned by Supabase Storage at upload
  status              text not null default 'created'
                        check (status in ('created', 'approved', 'rejected', 'delivered')),
  rejection_reason    text,
  reviewed_by         text,
  reviewed_at         timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_sms_campaign_organizer on sms_campaign (organizer_id, created_at desc);
create index if not exists idx_sms_campaign_status on sms_campaign (status, created_at desc);

-- Only the backend (service role) touches these tables.
alter table sms_credits enable row level security;
alter table sms_credit_transactions enable row level security;
alter table sms_campaign enable row level security;

-- ─── Storage bucket for the numbers .txt files ───────────────────────────
-- Private: phone numbers are personal data. The admin dashboard gets a
-- short-lived signed URL when it opens a campaign.
insert into storage.buckets (id, name, public)
values ('sms-campaigns', 'sms-campaigns', false)
on conflict (id) do nothing;

-- ════════════════════════════════════════════════════════════════════════
-- RPC FUNCTIONS
-- ════════════════════════════════════════════════════════════════════════

create or replace function get_or_init_sms_credits(p_organizer_id text)
returns sms_credits as $$
declare
  v_row sms_credits;
begin
  insert into sms_credits (organizer_id) values (p_organizer_id)
  on conflict (organizer_id) do nothing;
  select * into v_row from sms_credits where organizer_id = p_organizer_id;
  return v_row;
end;
$$ language plpgsql;

-- Idempotent on p_reference: a second call with the same reference is a no-op.
create or replace function grant_sms_credits(
  p_organizer_id text, p_amount integer, p_reference text
) returns sms_credits as $$
declare
  v_row sms_credits;
begin
  if p_amount <= 0 then
    raise exception 'grant amount must be positive';
  end if;

  insert into sms_credits (organizer_id) values (p_organizer_id)
  on conflict (organizer_id) do nothing;

  select * into v_row from sms_credits where organizer_id = p_organizer_id for update;

  if exists (
    select 1 from sms_credit_transactions where type = 'purchase' and reference = p_reference
  ) then
    return v_row;
  end if;

  update sms_credits
    set available = available + p_amount, updated_at = now()
    where organizer_id = p_organizer_id
    returning * into v_row;

  insert into sms_credit_transactions (organizer_id, type, amount, reference, reason)
  values (p_organizer_id, 'purchase', p_amount, p_reference, 'SMS credit purchase');

  return v_row;
end;
$$ language plpgsql;

-- Creates the campaign AND reserves its credits in one transaction, so a
-- campaign can never exist without its credits being held (and vice versa).
create or replace function create_sms_campaign(
  p_organizer_id text, p_organizer_email text, p_organizer_username text,
  p_event_id text, p_event_name text, p_name text, p_message text,
  p_recipient_count integer, p_file_path text, p_file_url text
) returns sms_campaign as $$
declare
  v_credits  sms_credits;
  v_campaign sms_campaign;
begin
  if p_recipient_count <= 0 then
    raise exception 'recipient count must be positive';
  end if;

  select * into v_credits from sms_credits where organizer_id = p_organizer_id for update;
  if v_credits is null or v_credits.available < p_recipient_count then
    raise exception 'insufficient_credits';
  end if;

  update sms_credits
    set available = available - p_recipient_count,
        reserved  = reserved + p_recipient_count,
        updated_at = now()
    where organizer_id = p_organizer_id;

  insert into sms_campaign (
    organizer_id, organizer_email, organizer_username, event_id, event_name_snapshot,
    name, message_text, recipient_count, credits_reserved, numbers_file_path, numbers_file_url
  ) values (
    p_organizer_id, p_organizer_email, p_organizer_username, p_event_id, p_event_name,
    p_name, p_message, p_recipient_count, p_recipient_count, p_file_path, p_file_url
  ) returning * into v_campaign;

  insert into sms_credit_transactions (organizer_id, sms_campaign_id, type, amount, reason, created_by)
  values (p_organizer_id, v_campaign.id, 'reservation', -p_recipient_count, 'Bulk SMS created', p_organizer_id);

  return v_campaign;
end;
$$ language plpgsql;

create or replace function approve_sms_campaign(p_campaign_id uuid, p_admin text)
returns sms_campaign as $$
declare
  v_campaign sms_campaign;
begin
  select * into v_campaign from sms_campaign where id = p_campaign_id for update;
  if v_campaign is null then raise exception 'campaign_not_found'; end if;
  if v_campaign.status <> 'created' then raise exception 'invalid_state:%', v_campaign.status; end if;

  update sms_campaign
    set status = 'approved', reviewed_by = p_admin, reviewed_at = now(), updated_at = now()
    where id = p_campaign_id
    returning * into v_campaign;
  return v_campaign;
end;
$$ language plpgsql;

-- Rejecting (from created or approved, never once delivered) returns the
-- reserved credits to the booker's available balance.
create or replace function reject_sms_campaign(p_campaign_id uuid, p_reason text, p_admin text)
returns sms_campaign as $$
declare
  v_campaign sms_campaign;
begin
  select * into v_campaign from sms_campaign where id = p_campaign_id for update;
  if v_campaign is null then raise exception 'campaign_not_found'; end if;
  if v_campaign.status not in ('created', 'approved') then
    raise exception 'invalid_state:%', v_campaign.status;
  end if;

  update sms_credits
    set reserved = greatest(reserved - v_campaign.credits_reserved, 0),
        available = available + v_campaign.credits_reserved,
        updated_at = now()
    where organizer_id = v_campaign.organizer_id;

  insert into sms_credit_transactions (organizer_id, sms_campaign_id, type, amount, reason, created_by)
  values (v_campaign.organizer_id, p_campaign_id, 'reservation_release', v_campaign.credits_reserved,
          'Bulk SMS rejected', p_admin);

  update sms_campaign
    set status = 'rejected', rejection_reason = p_reason, reviewed_by = p_admin,
        reviewed_at = now(), updated_at = now()
    where id = p_campaign_id
    returning * into v_campaign;
  return v_campaign;
end;
$$ language plpgsql;

create or replace function deliver_sms_campaign(p_campaign_id uuid, p_admin text)
returns sms_campaign as $$
declare
  v_campaign sms_campaign;
begin
  select * into v_campaign from sms_campaign where id = p_campaign_id for update;
  if v_campaign is null then raise exception 'campaign_not_found'; end if;
  if v_campaign.status <> 'approved' then raise exception 'invalid_state:%', v_campaign.status; end if;

  update sms_credits
    set reserved = greatest(reserved - v_campaign.credits_reserved, 0),
        consumed = consumed + v_campaign.credits_reserved,
        updated_at = now()
    where organizer_id = v_campaign.organizer_id;

  insert into sms_credit_transactions (organizer_id, sms_campaign_id, type, amount, reason, created_by)
  values (v_campaign.organizer_id, p_campaign_id, 'delivery_consumption', 0,
          'Bulk SMS delivered', p_admin);

  update sms_campaign
    set status = 'delivered', delivered_at = now(), updated_at = now()
    where id = p_campaign_id
    returning * into v_campaign;
  return v_campaign;
end;
$$ language plpgsql;
