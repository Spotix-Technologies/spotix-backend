# v1/models

This backend has no ORM and no schema-enforced models — data lives directly
in Firestore (top-level collections + nested subcollections) and, for the
payout ledger, a Supabase Postgres table. Every `lib/<feature>/` module
reads and writes Firestore documents inline via `adminDb.collection(...)`
(see `v1/utils/firebase.js` for the client), rather than going through a
model/repository layer.

`v1/models/collections.js` is a **reference-only** index of the collection
and table names found across the codebase during this migration, grouped
by the feature that owns them. Nothing imports it — it changes no runtime
behavior. It exists so the shape of the data is discoverable in one place
instead of only by grepping `lib/`.

If you want real models (e.g. a thin `Ticket`/`Payout`/`VotingPoll` class
per collection with typed read/write helpers), that's a genuine follow-on
refactor of `lib/`, not something safe to bolt on mechanically without
tests — happy to do it as its own pass, feature by feature, if you want it.
