// v1/lib/payout/products/event.js
//
// Post-success analytics for an EVENT payout — extracted out of
// v1/payout.js's inline if/else so each product type (event/poll/
// election/merch) owns its own "what do I update once this payout
// resolves successfully" logic, same lib/<feature>/ convention already
// used elsewhere (payout, election, post-mortem, queue).
//
// Firestore-only: enqueues onto the SAME batch the caller is already
// building for admin/user analytics, so everything commits atomically
// together (or not at all).

import { FieldValue } from "firebase-admin/firestore";

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{ adminDb: FirebaseFirestore.Firestore, batch: FirebaseFirestore.WriteBatch, row: object }} ctx
 */
export async function recordEventPayout(fastify, { adminDb, batch, row }) {
  if (!row.event_id) {
    fastify.log.warn(`[payout/event] ${row.reference} marked is_event but has no event_id — skipping`);
    return;
  }
  batch.update(adminDb.collection("events").doc(row.event_id), {
    totalPaidOut: FieldValue.increment(row.amount),
  });
}
