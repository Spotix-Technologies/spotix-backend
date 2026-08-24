// v1/lib/election/analytics.js
//
// Step 5: admin/analytics daily/monthly/yearly aggregation, same three
// docs v1/lib/voting/analytics.js and v1/lib/ticket's admin-sales
// rollups feed — totalRevenue is a shared platform-wide metric across
// tickets/votes/election forms, so this adds to it rather than owning a
// separate figure. totalElectionForms/totalElectionFormFees are
// election-specific counters alongside it.

import { FieldValue } from "firebase-admin/firestore";
import { getWATDateParts } from "./wat-date.js";

export async function reportElectionAnalytics(fastify, adminDb, { totalAmount, serviceFee, reference }) {
  try {
    const { year, month, day } = getWATDateParts();
    const base   = adminDb.collection("admin").doc("analytics");
    const numAmt = Number(totalAmount ?? 0);

    const payload = {
      totalRevenue:            FieldValue.increment(numAmt),
      totalElectionForms:      FieldValue.increment(1),
      totalElectionFormFees:   FieldValue.increment(Number(serviceFee ?? 0)),
      lastUpdated:             FieldValue.serverTimestamp(),
    };

    const batch = adminDb.batch();
    batch.set(base.collection("daily").doc(day),     payload, { merge: true });
    batch.set(base.collection("monthly").doc(month), payload, { merge: true });
    batch.set(base.collection("yearly").doc(year),   payload, { merge: true });
    await batch.commit();

    fastify.log.info(`[election] Analytics updated — ₦${numAmt} form fee`);
  } catch (err) {
    fastify.log.error(`[election] Analytics update failed for ${reference} (non-blocking):`, err);
  }
}
