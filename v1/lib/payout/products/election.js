// v1/lib/payout/products/election.js
//
// Post-success analytics for an ELECTION (form-fee) payout.
//
// Elections live in Supabase, not Firestore (see lib/election-db.ts on the
// booker side), so unlike event.js/poll.js this can't enqueue onto the
// caller's Firestore batch — it awaits a Postgres RPC instead. The RPC
// (increment_election_paid_out, see /supabase/payout-schema-merch.sql)
// does the increment atomically in the database, the same guarantee
// FieldValue.increment() gives the Firestore-backed products — a
// read-then-write from here would race under concurrent payouts.
//
// This module didn't exist before this changeset: is_election support
// landed in the booker/API layer (lib/payout-db.ts, /api/elections/[id]/
// payout) but was never wired into the Paystack webhook's analytics side,
// so election payouts succeeded without ever updating a running total.

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{ supabaseAdmin: import('@supabase/supabase-js').SupabaseClient, row: object }} ctx
 */
export async function recordElectionPayout(fastify, { supabaseAdmin, row }) {
  if (!row.election_id) {
    fastify.log.warn(`[payout/election] ${row.reference} marked is_election but has no election_id — skipping`);
    return;
  }
  const { error } = await supabaseAdmin.rpc("increment_election_paid_out", {
    p_election_id: row.election_id,
    p_amount: row.amount,
  });
  if (error) {
    // Non-fatal — the payout itself already succeeded and settled with the
    // organizer; a totals-tracking miss here shouldn't be surfaced as a
    // failure of the payout. Logged loudly so it can be reconciled.
    fastify.log.error({ error }, `[payout/election] Failed to increment total_paid_out for election ${row.election_id}`);
  }
}
