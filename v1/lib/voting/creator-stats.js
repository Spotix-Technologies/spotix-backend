// v1/lib/voting/creator-stats.js
//
// Step 4c: user/{creatorId} stats. Shares the same fields ticket sales
// use (atomic/route.ts) so the booker dashboard shows a single combined
// total across events + polls.

import { FieldValue } from "firebase-admin/firestore";

export async function updateCreatorStats(fastify, adminDb, { creatorId, netAmount, numVotes, targetPollId, reference }) {
  if (!creatorId) {
    fastify.log.warn(`[voting] No creatorId on poll ${targetPollId} — skipping creator stats`);
    return;
  }

  try {
    const creatorRef  = adminDb.collection("users").doc(creatorId);
    const creatorSnap = await creatorRef.get();
    if (creatorSnap.exists) {
      await creatorRef.update({
        totalRevenue:   FieldValue.increment(netAmount),
        totalVotesSold: FieldValue.increment(numVotes),
      });
      fastify.log.info(`[voting] Creator stats updated for ${creatorId} — ₦${netAmount}`);
    } else {
      fastify.log.warn(`[voting] Creator doc ${creatorId} not found — skipping stats update`);
    }
  } catch (err) {
    fastify.log.error(`[voting] Creator stats update failed for ${reference} (non-blocking):`, err);
  }
}
