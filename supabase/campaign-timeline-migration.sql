-- supabase/campaign-timeline-migration.sql
--
-- Run AFTER credits-migration.sql, in the same Supabase project. Additive and
-- safe to re-run.
--
--   1. sms_campaign_events — an APPEND-ONLY ledger of everything that happens
--      to a bulk SMS campaign (created / approved / rejected / delivered),
--      written by the same RPCs that change the status, inside the same
--      transaction. Before this, sms_campaign only kept the LATEST reviewed_at /
--      delivered_at, so e.g. approve-then-reject overwrote the approval time.
--   2. list_campaigns() — email + SMS campaigns for one booker in a single
--      newest-first, keyset-paginated list (powers /campaign/list).
--
-- Deploy order: run this file, then deploy the backend. The old RPC bodies keep
-- working in the meantime (they just don't write events yet).

begin;

-- ─── 1. immutable event ledger ───────────────────────────────────────────
create table if not exists sms_campaign_events (
  id            bigint generated always as identity primary key,
  campaign_id   uuid not null references sms_campaign(id),   -- no cascade: history can't be deleted via the campaign
  organizer_id  text not null,
  event_type    text not null check (event_type in ('created', 'approved', 'rejected', 'delivered')),
  actor         text,    -- booker id for "created"; admin name for the rest
  note          text,    -- rejection reason
  created_at    timestamptz not null default clock_timestamp()
);
create index if not exists idx_sms_events_campaign on sms_campaign_events (campaign_id, created_at, id);
alter table sms_campaign_events enable row level security;

-- Append-only: no UPDATE, DELETE or TRUNCATE for anyone, service role included.
-- (A superuser can still disable the trigger — this stops accidents and app
-- bugs, it is not a defence against someone with full DB ownership.)
create or replace function sms_campaign_events_append_only() returns trigger as $$
begin
  raise exception 'sms_campaign_events is append-only';
end;
$$ language plpgsql;

drop trigger if exists trg_sms_events_no_change on sms_campaign_events;
create trigger trg_sms_events_no_change
  before update or delete on sms_campaign_events
  for each row execute function sms_campaign_events_append_only();

drop trigger if exists trg_sms_events_no_truncate on sms_campaign_events;
create trigger trg_sms_events_no_truncate
  before truncate on sms_campaign_events
  for each statement execute function sms_campaign_events_append_only();

-- Best-effort history for campaigns that already exist, rebuilt from the
-- timestamps they carry. Each insert is guarded per event type, so re-running
-- never duplicates. (An approval that was later overwritten by a rejection
-- can't be recovered — that is exactly the gap this ledger closes going forward.)
insert into sms_campaign_events (campaign_id, organizer_id, event_type, actor, created_at)
select c.id, c.organizer_id, 'created', c.organizer_id, c.created_at
from sms_campaign c
where not exists (select 1 from sms_campaign_events e where e.campaign_id = c.id and e.event_type = 'created');

insert into sms_campaign_events (campaign_id, organizer_id, event_type, actor, created_at)
select c.id, c.organizer_id, 'approved', c.reviewed_by, c.reviewed_at
from sms_campaign c
where c.status in ('approved', 'delivered') and c.reviewed_at is not null
  and not exists (select 1 from sms_campaign_events e where e.campaign_id = c.id and e.event_type = 'approved');

insert into sms_campaign_events (campaign_id, organizer_id, event_type, actor, note, created_at)
select c.id, c.organizer_id, 'rejected', c.reviewed_by, c.rejection_reason, c.reviewed_at
from sms_campaign c
where c.status = 'rejected' and c.reviewed_at is not null
  and not exists (select 1 from sms_campaign_events e where e.campaign_id = c.id and e.event_type = 'rejected');

insert into sms_campaign_events (campaign_id, organizer_id, event_type, actor, created_at)
select c.id, c.organizer_id, 'delivered', c.reviewed_by, c.delivered_at
from sms_campaign c
where c.status = 'delivered' and c.delivered_at is not null
  and not exists (select 1 from sms_campaign_events e where e.campaign_id = c.id and e.event_type = 'delivered');

-- ─── RPCs: same behaviour as before, plus one ledger row per transition ──

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

  insert into sms_campaign_events (campaign_id, organizer_id, event_type, actor, created_at)
  values (v_campaign.id, p_organizer_id, 'created', p_organizer_id, v_campaign.created_at);

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

  insert into sms_campaign_events (campaign_id, organizer_id, event_type, actor)
  values (p_campaign_id, v_campaign.organizer_id, 'approved', p_admin);

  return v_campaign;
end;
$$ language plpgsql;

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

  insert into sms_campaign_events (campaign_id, organizer_id, event_type, actor, note)
  values (p_campaign_id, v_campaign.organizer_id, 'rejected', p_admin, p_reason);

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

  insert into sms_campaign_events (campaign_id, organizer_id, event_type, actor)
  values (p_campaign_id, v_campaign.organizer_id, 'delivered', p_admin);

  return v_campaign;
end;
$$ language plpgsql;

-- ─── 2. unified campaign list (email + SMS) ──────────────────────────────
create index if not exists idx_campaigns_organizer_created on campaigns (organizer_id, created_at desc);

-- Newest first, keyset-paginated on (created_at, id). Pass the last row's
-- created_at (the exact string returned) and id back in as the cursor.
create or replace function list_campaigns(
  p_organizer_id text,
  p_kind         text default 'all',
  p_limit        integer default 15,
  p_cursor_ts    timestamptz default null,
  p_cursor_id    text default null
) returns table (
  id         text,
  type       text,
  name       text,
  status     text,
  event_id   text,
  event_name text,
  recipients integer,
  created_at timestamptz
) as $$
  select x.id, x.type, x.name, x.status, x.event_id, x.event_name, x.recipients, x.created_at
  from (
    select c.id::text as id, 'email'::text as type, c.name, c.status, c.event_id,
           c.event_name_snapshot as event_name, c.total_recipients as recipients, c.created_at
    from campaigns c
    where p_kind in ('all', 'email') and c.organizer_id = p_organizer_id

    union all

    select s.id::text, 'sms'::text, s.name, s.status, s.event_id,
           s.event_name_snapshot, s.recipient_count, s.created_at
    from sms_campaign s
    where p_kind in ('all', 'sms') and s.organizer_id = p_organizer_id
  ) x
  where (p_cursor_ts is null or (x.created_at, x.id) < (p_cursor_ts, p_cursor_id))
  order by x.created_at desc, x.id desc
  limit greatest(least(p_limit, 100), 1);
$$ language sql stable;

commit;
