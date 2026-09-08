// v1/lib/merch/admin-merch-sales.js
//
// Per-line-item daily aggregation at admin/merch/{listingId}/{YYYY-MM-DD}
// — mirrors admin/events/{eventId}/{date} (lib/ticket/admin-sales.js) and
// admin/votes/{pollId}/{date} (lib/voting/daily-aggregation.js). Called
// once per cart line item from index.js.
//
// merchSales is NET (post-fee, post-burden) since that's the only amount
// ever eligible for the booker's payout — same Burden-of-Fee math
// admin-sales.js uses for tickets, just without the addon/agent-incentive
// terms merch doesn't have. The order's transactionFee/
// organizerPaystackFeeCost are order-level (one 5% fee per checkout, not
// per line), so index.js allocates them across lines proportionally by
// lineTotal share before calling this.

import { FieldValue } from "firebase-admin/firestore";
import { getWATDateParts } from "./wat-date.js";

export async function updateDailyMerchSales(fastify, adminDb, { listingId, productName, quantity, netLineAmount, reference }) {
  try {
    const { day } = getWATDateParts();
    const nowIso = new Date().toISOString();
    const dailyRef = adminDb
      .collection("admin")
      .doc("merch")
      .collection(listingId)
      .doc(day);

    const dailySnap = await dailyRef.get();
    if (!dailySnap.exists) {
      await dailyRef.set({
        productName: productName ?? "",
        orderCount: 1,
        unitsSold: quantity,
        merchSales: netLineAmount,
        lastOrderTime: nowIso,
        createdAt: nowIso,
        lastUpdated: nowIso,
      });
    } else {
      await dailyRef.update({
        orderCount: FieldValue.increment(1),
        unitsSold: FieldValue.increment(quantity),
        merchSales: FieldValue.increment(netLineAmount),
        lastOrderTime: nowIso,
        lastUpdated: nowIso,
      });
    }

    fastify.log.info(`[merch] Daily sales updated for listing ${listingId} on ${day}`);
  } catch (err) {
    fastify.log.error(`[merch] Daily aggregation failed for ${reference} (non-blocking):`, err);
  }
}
