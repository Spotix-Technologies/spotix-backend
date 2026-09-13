// v1/lib/payout/products/poll.js
//
// Post-success analytics for a POLL (voting) payout. See event.js for the
// shape/rationale — same idea, "voting" collection instead of "events".

import { FieldValue } from "firebase-admin/firestore";

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{ adminDb: FirebaseFirestore.Firestore, batch: FirebaseFirestore.WriteBatch, row: object }} ctx
 */
export async function recordPollPayout(fastify, { adminDb, batch, row }) {
  if (!row.poll_id) {
    fastify.log.warn(`[payout/poll] ${row.reference} marked is_poll but has no poll_id — skipping`);
    return;
  }
  batch.update(adminDb.collection("voting").doc(row.poll_id), {
    totalPaidOut: FieldValue.increment(row.amount),
  });
}
