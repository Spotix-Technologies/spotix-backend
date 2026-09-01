# Attendee Post Mortem — setup

New feature: a "Post Mortem" option next to Guest Registry under the
Attendees tab's Download dropdown. Only enabled once an event has ended.
Generates one PDF per event (first/last buyer, purchase timeline chart,
check-in patterns, fun awards, full attendee table), computed exactly
once and stored in Supabase Storage.

## 1. spotix-backend — install new deps

```
npm install pdfkit svg-to-pdfkit
```

(`@dicebear/core` + `@dicebear/collection` are already a dependency —
see `v1/dicebear.js` — reused here for the avatar SVGs in the PDF.)

## 2. Supabase — run the schema

Run `supabase/post-mortem-schema.sql` in the Supabase SQL editor (same
project `v1/lib/supabase-admin.js` already points at). It creates:

- `public.post_mortems` — one row per event, `event_id` as primary key
  (that's what makes "only ever generate once" a DB guarantee).
- A **private** Storage bucket `post-mortems` — service-role only, PDFs
  are only ever reachable via short-lived signed URLs minted by
  `GET /v1/post-mortem/status`.

## 3. Mailjet — create the template

`v1/emails/attendee-post-mortem-ready.html` is a preview/starting point —
recreate it as a template in your Mailjet dashboard (same as the other
files in `v1/emails/`), then set its numeric Template ID as:

```
MJ_POST_MORTEM_READY_TEMPLATE_ID=<the id>
```

Variables the template expects: `username`, `event_name`, `download_url`,
`year`. Until this env var is set, generation still completes and the
report is still downloadable from the Attendees tab — the ready-email
just gets skipped (logged as a warning) rather than failing the whole run.

## 4. Env vars already assumed to exist

Nothing new needed on the booker side — the new route
(`app/api/event/list/[eventId]/post-mortem/route.ts`) reuses
`NEXT_PUBLIC_BACKEND_URL` and `CRON_SECRET`, the same pair
`lib/payout-backend.ts` already uses to call spotix-backend internally.

## How it works, briefly

1. Booker's `POST .../post-mortem` checks tab access + that the event has
   actually ended, then calls `spotix-backend`'s
   `POST /v1/post-mortem/generate` (internal-secret protected).
2. Backend claims the event via a single conditional Supabase write
   (`post_mortems.event_id` as PK), responds immediately, then in the
   background: reads the full attendee roster from Firestore directly,
   computes stats, renders the PDF with pdfkit, uploads it to Storage,
   marks the row `ready`, and emails the requester.
3. The dialog polls `GET .../post-mortem` every 5s while open; the user
   is told they can close it and wait for the email instead.
4. Once `ready`, downloading always re-fetches a fresh signed URL rather
   than caching one, since they expire after 10 minutes.
5. A `failed` row can be retried (same button); a `ready` row cannot —
   the whole point is it's computed once.
