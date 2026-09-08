// v1/lib/merch/analytics.js
//
// Step: admin/analytics daily/monthly/yearly aggregation
// (totalRevenue, totalMerchOrders, totalMerchUnits, totalTransactionFees).
// Called once per whole checkout (not once per cart line) — mirrors
// lib/voting/analytics.js, sharing the same admin/analytics/{daily,
// monthly,yearly} docs tickets and votes already write to, so
// totalRevenue reflects every kind of sale across the platform.
//
// Unlike tickets/voting, fee burden here is per-listing, not per-order, so
// there's no single "did the buyer bear it" boolean to check — `transactionFee`
// is already "the Spotix fee actually charged to the buyer, summed across
// lines" (create-merch-ref computes it that way), naturally 0 when every
// line's booker chose to absorb it themselves.

import { FieldValue } from "firebase-admin/firestore";
import { getWATDateParts } from "./wat-date.js";

export async function reportMerchAnalytics(fastify, adminDb, { totalUnitsCount, totalAmount, transactionFee, reference }) {
  try {
    const { year, month, day } = getWATDateParts();
    const base = adminDb.collection("admin").doc("analytics");
    const numUnits = Number(totalUnitsCount ?? 0);
    const numAmt = Number(totalAmount ?? 0);
    const numFee = Number(transactionFee ?? 0);

    const payload = {
      totalRevenue: FieldValue.increment(numAmt),
      totalMerchOrders: FieldValue.increment(1),
      totalMerchUnits: FieldValue.increment(numUnits),
      lastUpdated: FieldValue.serverTimestamp(),
    };

    // Only a nonzero fee is worth tracking — a fully organizer-absorbed
    // order legitimately contributes 0 here.
    if (numFee > 0) {
      payload.totalTransactionFees = FieldValue.increment(numFee);
    }

    const batch = adminDb.batch();
    batch.set(base.collection("daily").doc(day), payload, { merge: true });
    batch.set(base.collection("monthly").doc(month), payload, { merge: true });
    batch.set(base.collection("yearly").doc(year), payload, { merge: true });
    await batch.commit();

    fastify.log.info(`[merch] Analytics updated — ₦${numAmt} / ${numUnits} unit(s)`);
  } catch (err) {
    fastify.log.error(`[merch] Analytics update failed for ${reference} (non-blocking):`, err);
  }
}
