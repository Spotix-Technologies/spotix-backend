// v1/lib/payout/products/index.js
//
// Single entry point v1/payout.js calls once a payout row resolves
// "successful" — picks the right product module (event/poll/election/
// merch) off the row's is_* flags and lets it record whatever
// product-specific analytics it owns (see each sibling file). Adding a
// fifth product later means adding one file here and one line below,
// not another branch inside payout.js itself.

import { recordEventPayout } from "./event.js";
import { recordPollPayout } from "./poll.js";
import { recordElectionPayout } from "./election.js";
import { recordMerchPayout } from "./merch.js";

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{
 *   adminDb: FirebaseFirestore.Firestore,
 *   supabaseAdmin: import('@supabase/supabase-js').SupabaseClient,
 *   batch: FirebaseFirestore.WriteBatch,
 *   row: object,
 * }} ctx
 */
export async function recordProductPayout(fastify, ctx) {
  const { row } = ctx;

  // is_poll checked before is_event on purpose: a couple of legacy rows
  // predating the election/merch flags have both is_event and is_poll
  // unset-vs-true in inconsistent ways; is_poll's own branch already took
  // priority over eventId in the pre-refactor payout.js, preserved here.
  if (row.is_poll) return recordPollPayout(fastify, ctx);
  if (row.is_election) return recordElectionPayout(fastify, ctx);
  if (row.is_merch) return recordMerchPayout(fastify, ctx);
  if (row.is_event || row.event_id) return recordEventPayout(fastify, ctx);

  fastify.log.warn(`[payout/products] ${row.reference} matched no known product type — skipping analytics`);
}
