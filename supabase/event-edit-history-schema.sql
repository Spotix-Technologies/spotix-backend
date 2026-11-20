-- supabase/event-edit-history-schema.sql
--
-- Audit trail of every edit made to an event from spotix-booker (organizer +
-- event teammates) and, via the same table, anything Spotix staff change.
-- Written ONLY by spotix-backend (service-role key) through
-- POST /v1/edit-history; read ONLY through GET /v1/edit-history. The browser
-- never talks to this table directly, hence RLS on with no policies.
--
-- Run once in the Supabase SQL editor. Safe to re-run (IF NOT EXISTS).

create extension if not exists pgcrypto;

create table if not exists public.event_edit_history (
  id            uuid primary key default gen_random_uuid(),

  -- What was edited
  event_id      text        not null,          -- Firestore events/{eventId}
  organizer_id  text        not null,          -- the event's creator uid
  action        text        not null,          -- e.g. event_updated, slug_changed, discount_created
  summary       text        not null default '',  -- one-line human readable ("Changed ticket prices, venue")
  changes       jsonb       not null default '{}'::jsonb, -- { field: { before, after } }
  reason        text,                          -- optional free-text (admin edits require one)

  -- Who did it
  actor_uid     text        not null,
  actor_type    text        not null default 'organizer'
                  check (actor_type in ('organizer', 'event_teammate', 'Spotix')),
  actor_role    text,                          -- owner | admin | checkin | accountant | custom role name | Spotix role
  actor_name    text,                          -- username snapshot at the time of the edit

  -- Where it came from
  source        text        not null default 'booker'
                  check (source in ('booker', 'admin', 'system')),

  created_at    timestamptz not null default now()
);

-- Timeline for one event, newest first (booker tab + admin panel).
create index if not exists event_edit_history_event_created_idx
  on public.event_edit_history (event_id, created_at desc);

-- "What has this organizer's team changed lately" (support / abuse review).
create index if not exists event_edit_history_organizer_created_idx
  on public.event_edit_history (organizer_id, created_at desc);

-- Filter by kind of edit inside an event.
create index if not exists event_edit_history_event_action_idx
  on public.event_edit_history (event_id, action);

-- Lock the table down: service role bypasses RLS, everyone else gets nothing.
alter table public.event_edit_history enable row level security;

-- History is append-only. Block UPDATE/DELETE even for privileged app code
-- that might one day use a non-service key by mistake.
create or replace function public.event_edit_history_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'event_edit_history is append-only';
end;
$$;

drop trigger if exists event_edit_history_no_update on public.event_edit_history;
create trigger event_edit_history_no_update
  before update on public.event_edit_history
  for each row execute function public.event_edit_history_immutable();

drop trigger if exists event_edit_history_no_delete on public.event_edit_history;
create trigger event_edit_history_no_delete
  before delete on public.event_edit_history
  for each row execute function public.event_edit_history_immutable();
