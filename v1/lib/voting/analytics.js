// v1/lib/voting/analytics.js
//
// Step 5: admin/analytics daily/monthly/yearly aggregation
// (totalRevenue, totalVotes, totalTransactionFees).

import { FieldValue } from "firebase-admin/firestore";
import { getWATDateParts } from "./wat-date.js";

export async function reportVotingAnalytics(fastify, adminDb, { voteCount, totalAmount, buyerBearsBurden, serviceFee, reference }) {
  try {
    const { year, month, day } = getWATDateParts();
    const base     = adminDb.collection("admin").doc("analytics");
    const numVotes = Number(voteCount  ?? 1);
    const numAmt   = Number(totalAmount ?? 0);

    const payload = {
      totalRevenue: FieldValue.increment(numAmt),
      totalVotes:   FieldValue.increment(numVotes),
      lastUpdated:  FieldValue.serverTimestamp(),
    };

    // Only track totalTransactionFees when the buyer bore the burden — that's
    // the only case where the fee is a distinct, separately-charged amount.
    if (buyerBearsBurden) {
      payload.totalTransactionFees = FieldValue.increment(serviceFee);
    }

    const batch = adminDb.batch();
    batch.set(base.collection("daily").doc(day),     payload, { merge: true });
    batch.set(base.collection("monthly").doc(month), payload, { merge: true });
    batch.set(base.collection("yearly").doc(year),   payload, { merge: true });
    await batch.commit();

    fastify.log.info(`[voting] Analytics updated — ₦${numAmt} / ${numVotes} vote(s)`);
  } catch (err) {
    fastify.log.error(`[voting] Analytics update failed for ${reference} (non-blocking):`, err);
  }
}
