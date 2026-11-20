# Changes

## 1. Event edit history in Supabase
- `supabase/event-edit-history-schema.sql` (**new**) – `public.event_edit_history` table, 3 indexes, RLS on (service-role only), append-only triggers blocking UPDATE/DELETE. Run once in the Supabase SQL editor.
- `v1/lib/edit-history/diff.js` (**new**) – before/after → `{ field: { before, after } }`; ignores system counters (`updatedAt`, `usedCount`, `ticketsSold`), strips secret-looking keys, truncates oversized values, treats `5000`/`"5000"` and `""`/`null` as equal so form round-trips don't create fake edits; builds the one-line summary.
- `v1/lib/edit-history/repo.js` (**new**) – `recordEditHistory()` (validates, resolves the actor's username from `users/{uid}` with a 10-min in-memory cache, skips no-op saves) and `listEditHistory()` (newest-first, `before` cursor, `limit+1` trick for `hasMore`).
- `v1/routes/edit-history.js` (**new**) – internal-only (`x-internal-secret`): `POST /v1/edit-history`, `GET /v1/edit-history?eventId=&limit=&before=`.
- `server.js` – registers the route.
- `tests/unit/edit-history-diff.test.js` (**new**) – vitest coverage for the pure diff/sanitize/summary logic.
