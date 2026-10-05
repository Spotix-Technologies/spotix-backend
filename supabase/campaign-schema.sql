-- supabase/campaign-schema.sql
--
-- Spotix Campaigns (email marketing) — Phase 1 schema.
-- Run this against the SAME Supabase project spotix-booker/spotix-backend
-- already use (see v1/lib/supabase-admin.js) — no new project needed.
--
-- Events themselves stay in Firebase (events/{eventId}). Nothing here
-- duplicates the event document — only the immutable snapshot values a
-- campaign needs to stay historically consistent (event_name_snapshot,
-- event_slug_snapshot) are copied onto the campaign row at creation time.
--
-- Credit accounting model (spec §14): available / reserved / consumed,
-- all mutated only through the RPC functions below so every change is
-- atomic and race-safe (concurrent campaign starts on the same event
-- cannot oversell credits).

-- ─── event_credits ───────────────────────────────────────────────────────
-- One row per event. The credit balance belongs to the EVENT, not the
-- organizer (spec §10) — never sum this across an organizer's events.
create table if not exists event_credits (
  event_id          text primary key,
  organizer_id      text not null,
  available         integer not null default 0,
  reserved          integer not null default 0,
  consumed          integer not null default 0,
  statistics_enabled boolean not null default false,
  free_credit_granted boolean not null default false, -- idempotency flag, spec §43
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint event_credits_non_negative check (available >= 0 and reserved >= 0 and consumed >= 0)
);
create index if not exists idx_event_credits_organizer on event_credits (organizer_id);

-- ─── credit_transactions ─────────────────────────────────────────────────
-- Immutable ledger. Every balance mutation above gets one row here —
-- spec §42: "Never simply mutate a number without recording why."
create table if not exists credit_transactions (
  id            uuid primary key default gen_random_uuid(),
  event_id      text not null references event_credits(event_id),
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
create index if not exists idx_credit_tx_event on credit_transactions (event_id, created_at desc);
create index if not exists idx_credit_tx_campaign on credit_transactions (campaign_id);

-- ─── campaigns ────────────────────────────────────────────────────────────
create table if not exists campaigns (
  id                    uuid primary key default gen_random_uuid(),
  event_id              text not null,
  organizer_id          text not null,
  event_name_snapshot   text not null,
  event_slug_snapshot   text not null,
  name                  text not null, -- also the email subject, spec §28
  subject               text not null,
  sender_email          text not null,
  sender_name           text not null,
  template_id           text,
  message_html          text,
  button_url            text,
  status                text not null default 'draft' check (status in (
                          'draft', 'queued', 'processing', 'paused', 'completed',
                          'completed_with_errors', 'failed', 'waiting_for_provider', 'cancelled'
                        )),
  delivery_provider     text check (delivery_provider in ('resend', 'ses', null)),
  statistics_enabled    boolean not null default false,
  total_recipients      integer not null default 0,
  queued_count          integer not null default 0,
  sent_count            integer not null default 0,
  delivered_count       integer not null default 0,
  opened_count          integer not null default 0,
  clicked_count          integer not null default 0,
  bounced_count         integer not null default 0,
  failed_count          integer not null default 0,
  complained_count      integer not null default 0,
  credits_reserved      integer not null default 0,
  credits_consumed      integer not null default 0,
  credits_refunded      integer not null default 0,
  created_at            timestamptz not null default now(),
  started_at            timestamptz,
  completed_at          timestamptz,
  updated_at            timestamptz not null default now()
);
create index if not exists idx_campaigns_event on campaigns (event_id);
create index if not exists idx_campaigns_organizer on campaigns (organizer_id);
create index if not exists idx_campaigns_created on campaigns (created_at desc);
create index if not exists idx_campaigns_status on campaigns (status);

-- ─── campaign_recipients ──────────────────────────────────────────────────
create table if not exists campaign_recipients (
  id                  uuid primary key default gen_random_uuid(),
  campaign_id         uuid not null references campaigns(id) on delete cascade,
  contact_id          uuid,
  email               text not null, -- normalized (trim + lowercase), spec §46
  name                text,
  status              text not null default 'pending' check (status in (
                        'pending', 'sending', 'sent', 'delivered', 'opened',
                        'clicked', 'bounced', 'failed', 'complained'
                      )),
  provider_message_id text,
  attempt_count       integer not null default 0,
  last_attempt_at     timestamptz,
  next_retry_at       timestamptz,
  last_error          text,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  opened_at           timestamptz,
  clicked_at          timestamptz,
  bounced_at          timestamptz,
  failed_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_campaign_recipient_email unique (campaign_id, email)
);
create index if not exists idx_campaign_recipients_campaign on campaign_recipients (campaign_id);
create index if not exists idx_campaign_recipients_email on campaign_recipients (email);
create index if not exists idx_campaign_recipients_status on campaign_recipients (status);
create index if not exists idx_campaign_recipients_retry on campaign_recipients (next_retry_at) where status = 'failed';

-- ─── email_events ─────────────────────────────────────────────────────────
-- Immutable provider-event audit trail — campaign_recipients holds current
-- state, this holds history (spec §8).
create table if not exists email_events (
  id                      uuid primary key default gen_random_uuid(),
  campaign_id             uuid not null references campaigns(id) on delete cascade,
  campaign_recipient_id   uuid not null references campaign_recipients(id) on delete cascade,
  provider                text not null check (provider in ('resend', 'ses')),
  provider_event_id       text, -- used for webhook dedup, spec §4/§34
  event_type              text not null,
  event_timestamp         timestamptz not null default now(),
  payload                 jsonb,
  created_at              timestamptz not null default now()
);
create index if not exists idx_email_events_campaign on email_events (campaign_id);
create index if not exists idx_email_events_recipient on email_events (campaign_recipient_id);
-- Dedup guard: the same provider event id must only ever be processed once.
create unique index if not exists uq_email_events_provider_event
  on email_events (provider, provider_event_id) where provider_event_id is not null;

-- ─── contacts ─────────────────────────────────────────────────────────────
create table if not exists contacts (
  id            uuid primary key default gen_random_uuid(),
  organizer_id  text not null,
  email         text not null,
  name          text,
  attendee_id   text,
  source        text check (source in ('event_attendee', 'previous_event', 'external_import')),
  unsubscribed  boolean not null default false, -- spec §55
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint uq_contacts_organizer_email unique (organizer_id, email)
);
create index if not exists idx_contacts_organizer on contacts (organizer_id);
create index if not exists idx_contacts_email on contacts (email);

-- Phase 4 additive columns — organizer's plain-text message and chosen
-- accent color for the 3 production templates (spec §26). Rendering
-- always happens server-side from these, never raw frontend HTML.
alter table campaigns add column if not exists message_text text;
alter table campaigns add column if not exists brand_color text not null default '#6D28D9';

-- Phase 5 additive column — optional booker-supplied Reply-To address.
-- sender_email stays the fixed notification@ technical address (never
-- edited by the organizer); this is only where replies get routed, and
-- is null when the organizer didn't set one.
alter table campaigns add column if not exists reply_to_address text;

-- ════════════════════════════════════════════════════════════════════════
-- RPC FUNCTIONS — all credit mutations go through these (atomic, race-safe)
-- ════════════════════════════════════════════════════════════════════════

-- Grants the one-time 200 free credits (spec §43). Safe to call on every
-- "load the campaign page" request — the free_credit_granted flag plus the
-- row-level lock make it a true no-op after the first successful call.
create or replace function init_event_credits(p_event_id text, p_organizer_id text)
returns event_credits as $$
declare
  v_row event_credits;
begin
  select * into v_row from event_credits where event_id = p_event_id for update;

  if v_row is null then
    insert into event_credits (event_id, organizer_id, available, free_credit_granted)
    values (p_event_id, p_organizer_id, 200, true)
    returning * into v_row;

    insert into credit_transactions (event_id, type, amount, source, reason)
    values (p_event_id, 'free_credit', 200, 'system', 'Initial free campaign credits');
  elsif not v_row.free_credit_granted then
    update event_credits
      set available = available + 200, free_credit_granted = true, updated_at = now()
      where event_id = p_event_id
      returning * into v_row;

    insert into credit_transactions (event_id, type, amount, source, reason)
    values (p_event_id, 'free_credit', 200, 'system', 'Initial free campaign credits');
  end if;

  return v_row;
end;
$$ language plpgsql;

-- Reserves credits for a campaign about to start. Fails (raises) rather
-- than going negative — the caller should catch and surface "insufficient
-- credits" (spec §15).
create or replace function reserve_campaign_credits(
  p_event_id text, p_campaign_id uuid, p_amount integer, p_created_by text
) returns event_credits as $$
declare
  v_row event_credits;
begin
  if p_amount <= 0 then
    raise exception 'reserve amount must be positive';
  end if;

  select * into v_row from event_credits where event_id = p_event_id for update;
  if v_row is null or v_row.available < p_amount then
    raise exception 'insufficient_credits';
  end if;

  update event_credits
    set available = available - p_amount, reserved = reserved + p_amount, updated_at = now()
    where event_id = p_event_id
    returning * into v_row;

  insert into credit_transactions (event_id, campaign_id, type, amount, created_by, reason)
  values (p_event_id, p_campaign_id, 'reservation', -p_amount, p_created_by, 'Campaign started');

  return v_row;
end;
$$ language plpgsql;

-- One recipient confirmed delivered: reserved -1, consumed +1 (spec §14).
create or replace function consume_recipient_credit(p_event_id text, p_campaign_id uuid)
returns event_credits as $$
declare
  v_row event_credits;
begin
  update event_credits
    set reserved = greatest(reserved - 1, 0), consumed = consumed + 1, updated_at = now()
    where event_id = p_event_id
    returning * into v_row;

  insert into credit_transactions (event_id, campaign_id, type, amount, reason)
  values (p_event_id, p_campaign_id, 'delivery_consumption', -1, 'Delivery confirmed');

  return v_row;
end;
$$ language plpgsql;

-- One recipient permanently failed (will not be retried): reserved -1,
-- available +1 — the credit becomes reusable (spec §14).
create or replace function refund_recipient_credit(p_event_id text, p_campaign_id uuid)
returns event_credits as $$
declare
  v_row event_credits;
begin
  update event_credits
    set reserved = greatest(reserved - 1, 0), available = available + 1, updated_at = now()
    where event_id = p_event_id
    returning * into v_row;

  insert into credit_transactions (event_id, campaign_id, type, amount, reason)
  values (p_event_id, p_campaign_id, 'delivery_refund', 1, 'Permanent delivery failure');

  return v_row;
end;
$$ language plpgsql;

-- Admin manual adjustment (spec §42) — always ledgered with a reason.
create or replace function admin_adjust_event_credits(
  p_event_id text, p_organizer_id text, p_amount integer, p_reason text, p_created_by text
) returns event_credits as $$
declare
  v_row event_credits;
begin
  select * into v_row from event_credits where event_id = p_event_id for update;
  if v_row is null then
    insert into event_credits (event_id, organizer_id, available)
    values (p_event_id, p_organizer_id, greatest(p_amount, 0))
    returning * into v_row;
  else
    update event_credits
      set available = greatest(available + p_amount, 0), updated_at = now()
      where event_id = p_event_id
      returning * into v_row;
  end if;

  insert into credit_transactions (event_id, type, amount, source, reason, created_by)
  values (p_event_id, 'manual_adjustment', p_amount, 'admin', p_reason, p_created_by);

  return v_row;
end;
$$ language plpgsql;

-- Grants credits from a verified Paystack purchase (spec §16–17). Once a
-- statistics-enabled package is purchased, statistics stay enabled even
-- if a later purchase on the same event is credits-only — an
-- entitlement, once granted, is never silently revoked by this path.
create or replace function grant_purchased_credits(
  p_event_id text, p_organizer_id text, p_amount integer,
  p_reference text, p_statistics_enabled boolean
) returns event_credits as $$
declare
  v_row event_credits;
begin
  select * into v_row from event_credits where event_id = p_event_id for update;
  if v_row is null then
    insert into event_credits (event_id, organizer_id, available, statistics_enabled)
    values (p_event_id, p_organizer_id, p_amount, p_statistics_enabled)
    returning * into v_row;
  else
    update event_credits
      set available = available + p_amount,
          statistics_enabled = statistics_enabled or p_statistics_enabled,
          updated_at = now()
      where event_id = p_event_id
      returning * into v_row;
  end if;

  insert into credit_transactions (event_id, type, amount, source, reference, reason)
  values (p_event_id, 'purchase', p_amount, 'paystack', p_reference, 'Credit package purchase');

  return v_row;
end;
$$ language plpgsql;
