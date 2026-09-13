// v1/lib/payout/products/merch.js
//
// Post-success analytics for a MERCH LISTING payout — the new fourth
// product type alongside event/poll/election. Same Supabase-RPC shape as
// election.js (merch listings live in `merch_listings`, not Firestore).

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{ supabaseAdmin: import('@supabase/supabase-js').SupabaseClient, row: object }} ctx
 */
export async function recordMerchPayout(fastify, { supabaseAdmin, row }) {
  if (!row.merch_id) {
    fastify.log.warn(`[payout/merch] ${row.reference} marked is_merch but has no merch_id — skipping`);
    return;
  }
  const { error } = await supabaseAdmin.rpc("increment_merch_paid_out", {
    p_merch_id: row.merch_id,
    p_amount: row.amount,
  });
  if (error) {
    fastify.log.error({ error }, `[payout/merch] Failed to increment total_paid_out for listing ${row.merch_id}`);
  }
}
