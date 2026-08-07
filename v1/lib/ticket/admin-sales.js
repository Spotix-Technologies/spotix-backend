// v1/lib/ticket/admin-sales.js
//
// Step 8 of ticket generation: roll this sale into the booker's daily
// aggregate at admin/events/{eventId}/{YYYY-MM-DD}. For agent-facilitated
// sales, what lands here is the amount AFTER the agent's incentive is
// removed — the incentive was the agent's cut, not the booker's, so it
// never counted toward the booker's withdrawable balance in the first
// place (see agent-sale.js for the agent-side ledger entry the incentive
// amount actually goes to). Non-blocking.

import { FieldValue } from "firebase-admin/firestore";

export async function updateAdminDailySales(
  fastify,
  adminDb,
  { paymentData, totalTicketCount, agentIncentiveAmount, nowIso, purchaseTime }
) {
  const purchaseDateFormatted = nowIso.split("T")[0];
  const adminSalesRef = adminDb
    .collection("admin")
    .doc("events")
    .collection(paymentData.eventId)
    .doc(purchaseDateFormatted);

  const bookerNetAmount = Math.max(0, (paymentData.totalAmount || 0) - agentIncentiveAmount);

  try {
    const salesDoc = await adminSalesRef.get();
    // We hold the processingLock so no other request can reach this step
    // for this reference. No need to re-check ticketGenerated here.
    if (!salesDoc.exists) {
      await adminSalesRef.set({
        eventName: paymentData.eventName,
        ticketCount: totalTicketCount,
        ticketSales: bookerNetAmount,
        lastPurchaseTime: purchaseTime,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } else {
      await adminSalesRef.update({
        ticketCount: FieldValue.increment(totalTicketCount),
        ticketSales: FieldValue.increment(bookerNetAmount),
        lastPurchaseTime: purchaseTime,
        updatedAt: nowIso,
      });
    }

    fastify.log.info(`[step:8] Daily sales updated for ${purchaseDateFormatted}`);
  } catch (error) {
    fastify.log.error("[step:8] Daily sales aggregation error (non-blocking):", error);
  }
}
