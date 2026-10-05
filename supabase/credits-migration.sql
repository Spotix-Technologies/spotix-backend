-- supabase/credits-migration.sql
--
-- Account-level credits for EMAIL campaigns + unified credit ledger +
-- searchable SMS recipients.
--
-- Run ONCE in the same Supabase project as campaign-schema.sql / sms-schema.sql.
-- It is additive: event_credits / credit_transactions are left untouched
-- (nothing reads them any more) so you can roll back by redeploying the old
-- backend. Drop them yourself once you're happy.
--
-- DEPLOY ORDER: pause the process-campaigns cron -> run this file -> deploy the
-- new backend -> resume the cron. Balances are copied at the moment this runs,
-- so activity on the old code between the two steps would be lost.
--
-- What changes
--   1. email_credits / email_credit_transactions  — one balance per BOOKER
--      (organizer_id), same available / reserved / consumed model as SMS.
--      Existing per-event balances are summed per organizer, so nobody loses or
--      gains credits. The one-time 200 free credits now apply once per account.
--   2. get_credit_ledger()  — one function that returns email + SMS credit
--      movements in a single, filterable, keyset-paginated list.
--   3. sms_campaign_recipients  — one row per phone number per SMS campaign so
--      admins can look a number up (until now numbers only lived in a .txt file).
--   4. admin_adjust_sms_credits()  — manual SMS top-ups by admin.

begin;

-- ─── 1. email_credits (per organizer) ────────────────────────────────────
create table if not exists email_credits (
  organizer_id        text primary key,
  available           integer not null default 0,
  reserved            integer not null default 0,
  consumed            integer not null default 0,
  statistics_enabled  boolean not null default false,
  free_credit_granted boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint email_credits_non_negative check (available >= 0 and reserved >= 0 and consumed >= 0)
);

create table if not exists email_credit_transactions (
  id            uuid primary key default gen_random_uuid(),
  organizer_id  text not null,
  event_id      text,            -- the event the campaign was for (null for purchases / top-ups)
  campaign_id   uuid,
  type          text not null check (type in (
                  'free_credit', 'purchase', 'manual_adjustment',
                  'reservation', 'delivery_consumption', 'delivery_refund'
                )),
  amount        integer not null, -- signed: +credit, -debit
  source        text,
  reference     text,
  reason        text,
  created_by    text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_email_tx_organizer on email_credit_transactions (organizer_id, created_at desc);
create index if not exists idx_email_tx_campaign on email_credit_transactions (organizer_id, campaign_id, type);
-- A Paystack reference can only ever grant credits once.
create unique index if not exists uq_email_tx_purchase_reference
  on email_credit_transactions (reference) where type = 'purchase';

alter table email_credits enable row level security;
alter table email_credit_transactions enable row level security;

-- ─── data migration (idempotent) ─────────────────────────────────────────
insert into email_credits (organizer_id, available, reserved, consumed, statistics_enabled, free_credit_granted)
select organizer_id, sum(available), sum(reserved), sum(consumed),
       bool_or(statistics_enabled), bool_or(free_credit_granted)
from event_credits
group by organizer_id
on conflict (organizer_id) do nothing;

insert into email_credit_transactions (id, organizer_id, event_id, campaign_id, type, amount, source, reference, reason, created_by, created_at)
select ct.id, ec.organizer_id, ct.event_id, ct.campaign_id, ct.type, ct.amount, ct.source, ct.reference, ct.reason, ct.created_by, ct.created_at
from credit_transactions ct
join event_credits ec on ec.event_id = ct.event_id
on conflict do nothing;

-- ─── RPC: email credits (all mutations atomic + row-locked) ──────────────

-- Creates the account row and grants the one-time 200 free credits exactly
-- once per account. Safe to call on every page load.
create or replace function init_email_credits(p_organizer_id text)
returns email_credits as $$
declare
  v_row email_credits;
begin
  insert into email_credits (organizer_id) values (p_organizer_id)
  on conflict (organizer_id) do nothing;

  select * into v_row from email_credits where organizer_id = p_organizer_id for update;

  if not v_row.free_credit_granted then
    update email_credits
      set available = available + 200, free_credit_granted = true, updated_at = now()
      where organizer_id = p_organizer_id
      returning * into v_row;

    insert into email_credit_transactions (organizer_id, type, amount, source, reason)
    values (p_organizer_id, 'free_credit', 200, 'system', 'Initial free campaign credits');
  end if;

  return v_row;
end;
$$ language plpgsql;

create or replace function reserve_email_credits(
  p_organizer_id text, p_campaign_id uuid, p_event_id text, p_amount integer, p_created_by text
) returns email_credits as $$
declare
  v_row email_credits;
begin
  if p_amount <= 0 then
    raise exception 'reserve amount must be positive';
  end if;

  select * into v_row from email_credits where organizer_id = p_organizer_id for update;
  if v_row is null or v_row.available < p_amount then
    raise exception 'insufficient_credits';
  end if;

  update email_credits
    set available = available - p_amount, reserved = reserved + p_amount, updated_at = now()
    where organizer_id = p_organizer_id
    returning * into v_row;

  insert into email_credit_transactions (organizer_id, event_id, campaign_id, type, amount, created_by, reason)
  values (p_organizer_id, p_event_id, p_campaign_id, 'reservation', -p_amount, p_created_by, 'Campaign started');

  return v_row;
end;
$$ language plpgsql;

-- One recipient confirmed delivered: reserved -1, consumed +1.
create or replace function consume_email_credit(p_organizer_id text, p_campaign_id uuid, p_event_id text)
returns email_credits as $$
declare
  v_row email_credits;
begin
  update email_credits
    set reserved = greatest(reserved - 1, 0), consumed = consumed + 1, updated_at = now()
    where organizer_id = p_organizer_id
    returning * into v_row;

  insert into email_credit_transactions (organizer_id, event_id, campaign_id, type, amount, reason)
  values (p_organizer_id, p_event_id, p_campaign_id, 'delivery_consumption', -1, 'Delivery confirmed');

  return v_row;
end;
$$ language plpgsql;

-- One recipient permanently failed: reserved -1, available +1.
create or replace function refund_email_credit(p_organizer_id text, p_campaign_id uuid, p_event_id text)
returns email_credits as $$
declare
  v_row email_credits;
begin
  update email_credits
    set reserved = greatest(reserved - 1, 0), available = available + 1, updated_at = now()
    where organizer_id = p_organizer_id
    returning * into v_row;

  insert into email_credit_transactions (organizer_id, event_id, campaign_id, type, amount, reason)
  values (p_organizer_id, p_event_id, p_campaign_id, 'delivery_refund', 1, 'Permanent delivery failure');

  return v_row;
end;
$$ language plpgsql;

-- Admin top-up (or correction, if negative). Always ledgered with a reason.
-- The ledger records what was actually applied: a deduction can't take the
-- balance below zero, so it is clamped and the clamped amount is what's logged.
create or replace function admin_adjust_email_credits(
  p_organizer_id text, p_amount integer, p_reason text, p_created_by text
) returns email_credits as $$
declare
  v_row     email_credits;
  v_applied integer;
begin
  insert into email_credits (organizer_id) values (p_organizer_id)
  on conflict (organizer_id) do nothing;

  select * into v_row from email_credits where organizer_id = p_organizer_id for update;
  v_applied := greatest(p_amount, -v_row.available);

  update email_credits
    set available = available + v_applied, updated_at = now()
    where organizer_id = p_organizer_id
    returning * into v_row;

  insert into email_credit_transactions (organizer_id, type, amount, source, reason, created_by)
  values (p_organizer_id, 'manual_adjustment', v_applied, 'admin', p_reason, p_created_by);

  return v_row;
end;
$$ language plpgsql;

-- Grants credits from a verified Paystack purchase. Idempotent on p_reference.
create or replace function grant_email_credits_purchase(
  p_organizer_id text, p_amount integer, p_reference text, p_statistics_enabled boolean
) returns email_credits as $$
declare
  v_row email_credits;
begin
  if p_amount <= 0 then
    raise exception 'grant amount must be positive';
  end if;

  insert into email_credits (organizer_id) values (p_organizer_id)
  on conflict (organizer_id) do nothing;

  select * into v_row from email_credits where organizer_id = p_organizer_id for update;

  if exists (
    select 1 from email_credit_transactions where type = 'purchase' and reference = p_reference
  ) then
    return v_row;
  end if;

  update email_credits
    set available = available + p_amount,
        statistics_enabled = statistics_enabled or p_statistics_enabled,
        updated_at = now()
    where organizer_id = p_organizer_id
    returning * into v_row;

  insert into email_credit_transactions (organizer_id, type, amount, source, reference, reason)
  values (p_organizer_id, 'purchase', p_amount, 'paystack', p_reference, 'Credit package purchase');

  return v_row;
end;
$$ language plpgsql;

-- ─── 4. SMS manual top-up ────────────────────────────────────────────────
create or replace function admin_adjust_sms_credits(
  p_organizer_id text, p_amount integer, p_reason text, p_created_by text
) returns sms_credits as $$
declare
  v_row     sms_credits;
  v_applied integer;
begin
  insert into sms_credits (organizer_id) values (p_organizer_id)
  on conflict (organizer_id) do nothing;

  select * into v_row from sms_credits where organizer_id = p_organizer_id for update;
  v_applied := greatest(p_amount, -v_row.available);

  update sms_credits
    set available = available + v_applied, updated_at = now()
    where organizer_id = p_organizer_id
    returning * into v_row;

  insert into sms_credit_transactions (organizer_id, type, amount, reason, created_by)
  values (p_organizer_id, 'manual_adjustment', v_applied, p_reason, p_created_by);

  return v_row;
end;
$$ language plpgsql;

-- ─── 3. sms_campaign_recipients (searchable phone numbers) ───────────────
create table if not exists sms_campaign_recipients (
  id            bigint generated always as identity primary key,
  campaign_id   uuid not null references sms_campaign(id) on delete cascade,
  organizer_id  text not null,
  phone         text not null,   -- 11-digit local form, same as the .txt file
  created_at    timestamptz not null default now()
);
create unique index if not exists uq_sms_recipients_campaign_phone on sms_campaign_recipients (campaign_id, phone);
create index if not exists idx_sms_recipients_phone on sms_campaign_recipients (phone, created_at desc);
alter table sms_campaign_recipients enable row level security;

-- Same as before, plus the recipients are inserted in the SAME transaction as
-- the campaign and the credit reservation.
drop function if exists create_sms_campaign(text, text, text, text, text, text, text, integer, text, text);

create or replace function create_sms_campaign(
  p_organizer_id text, p_organizer_email text, p_organizer_username text,
  p_event_id text, p_event_name text, p_name text, p_message text,
  p_recipient_count integer, p_file_path text, p_file_url text,
  p_numbers text[] default null
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

  if p_numbers is not null then
    insert into sms_campaign_recipients (campaign_id, organizer_id, phone, created_at)
    select v_campaign.id, p_organizer_id, n, v_campaign.created_at
    from (select distinct unnest(p_numbers) as n) d;
  end if;

  insert into sms_credit_transactions (organizer_id, sms_campaign_id, type, amount, reason, created_by)
  values (p_organizer_id, v_campaign.id, 'reservation', -p_recipient_count, 'Bulk SMS created', p_organizer_id);

  return v_campaign;
end;
$$ language plpgsql;

-- ─── 2. unified ledger ───────────────────────────────────────────────────
-- Returns email + SMS credit movements for ONE organizer, newest first, as the
-- booker / admin should read them:
--
--   txn_type   purchase | used | manual | refund | free
--   direction  added (green) | deducted (red) | reserved (yellow)
--   credits    always a positive magnitude; direction carries the sign
--
-- Email logs one ledger row PER RECIPIENT for delivered / failed, which would
-- bury everything else, so those are rolled up to one row per campaign per
-- kind of movement. Keyset pagination on (created_at, entry_id): pass the last
-- row's created_at (as the exact string returned) and entry_id back in.
create or replace function get_credit_ledger(
  p_organizer_id text,
  p_kind         text default 'all',
  p_limit        integer default 25,
  p_cursor_ts    timestamptz default null,
  p_cursor_id    text default null
) returns table (
  entry_id    text,
  kind        text,
  txn_type    text,
  direction   text,
  credits     integer,
  reference   text,
  reason      text,
  event_id    text,
  campaign_id uuid,
  created_at  timestamptz
) as $$
  select x.entry_id, x.kind, x.txn_type, x.direction, x.credits, x.reference,
         x.reason, x.event_id, x.campaign_id, x.created_at
  from (
    -- email: rows that are one-per-event
    select t.id::text as entry_id, 'email'::text as kind,
           case t.type when 'purchase' then 'purchase' when 'free_credit' then 'free'
                       when 'manual_adjustment' then 'manual' else 'used' end as txn_type,
           case when t.type = 'reservation' then 'reserved'
                when t.amount >= 0 then 'added' else 'deducted' end as direction,
           abs(t.amount)::integer as credits,
           t.reference, t.reason, t.event_id, t.campaign_id, t.created_at
    from email_credit_transactions t
    where p_kind in ('all', 'email')
      and t.organizer_id = p_organizer_id
      and t.type in ('purchase', 'free_credit', 'manual_adjustment', 'reservation')

    union all

    -- email: per-recipient rows rolled up per campaign
    select ('agg:' || t.campaign_id::text || ':' || t.type) as entry_id, 'email'::text,
           case t.type when 'delivery_consumption' then 'used' else 'refund' end,
           case t.type when 'delivery_consumption' then 'deducted' else 'added' end,
           count(*)::integer,
           null::text,
           case t.type when 'delivery_consumption' then 'Delivered' else 'Failed deliveries returned' end,
           min(t.event_id), t.campaign_id, max(t.created_at)
    from email_credit_transactions t
    where p_kind in ('all', 'email')
      and t.organizer_id = p_organizer_id
      and t.type in ('delivery_consumption', 'delivery_refund')
      and t.campaign_id is not null
    group by t.campaign_id, t.type

    union all

    -- sms
    select t.id::text, 'sms'::text,
           case t.type when 'purchase' then 'purchase' when 'manual_adjustment' then 'manual'
                       when 'reservation_release' then 'refund' else 'used' end,
           case when t.type = 'reservation' then 'reserved'
                when t.type = 'delivery_consumption' then 'deducted'
                when t.type = 'manual_adjustment' and t.amount < 0 then 'deducted'
                else 'added' end,
           case when t.type = 'delivery_consumption' then coalesce(c.credits_reserved, 0)
                else abs(t.amount) end::integer,
           t.reference, t.reason, c.event_id, t.sms_campaign_id, t.created_at
    from sms_credit_transactions t
    left join sms_campaign c on c.id = t.sms_campaign_id
    where p_kind in ('all', 'sms')
      and t.organizer_id = p_organizer_id
  ) x
  where x.credits > 0
    and (p_cursor_ts is null or (x.created_at, x.entry_id) < (p_cursor_ts, p_cursor_id))
  order by x.created_at desc, x.entry_id desc
  limit greatest(least(p_limit, 100), 1);
$$ language sql stable;

commit;
