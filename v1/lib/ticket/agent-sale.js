// v1/lib/ticket/agent-sale.js
//
// Step 7b of ticket generation: runs once per successfully-paid
// agent-created reference (isAgentSale: true). Three things happen here:
//   1. Read the booker-set incentive config off events/{eventId}.agentIncentive
//      — event-wide now, the same rate for every agent selling this event
//      (previously per-agent at agentRequests/{eventId}/agents/{agentId}.incentive).
//      No config → incentive is 0, though in practice this shouldn't happen:
//      the booker can't enable agent activity without setting one (see
//      booker's PATCH /api/event/list/[eventId] action=toggleAgentActivity).
//   2. Compute the incentive amount:
//        "percentage" → paymentData.ticketPrice (subtotal, NOT the buyer fee) * value / 100
//        "flat"       → value, once per sale/reference (not multiplied by quantity)
//      and write it into agents/{agentId}/transactions/{YYYY-MM-DD} — the
//      same daily-aggregation shape booker's admin/events/{eventId}/{date}
//      already uses, so the existing 30-hour-lock withdrawal logic
//      (booker/app/api/payout/route.ts) can be mirrored for agents later
//      against this exact structure.
//   3. If this was a "pregenerated" pass sale, flip the reserved pool
//      tickets (agents/{agentId}/{eventId}/{ticketId}) from "reserved" to
//      "sold" — they were marked "reserved" at reference-creation time in
//      the agent app's POST /api/v1/agent/sale.
//
// Returns the incentive amount so the caller can subtract it from what gets
// recorded as the booker's revenue for the day.

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../firebase-admin.js";

// Signature intentionally matches the pre-split export exactly —
// ticket-agent.js imports { processAgentSale } from "./ticket.js" and
// calls it as processAgentSale(fastify, paymentData, totalTicketCount, nowIso).
// ticket.js re-exports this function unchanged, so that call site needs no edits.
export async function processAgentSale(fastify, paymentData, totalTicketCount, nowIso) {
  const { eventId, agentId, ticketPrice = 0 } = paymentData;
  const purchaseDateFormatted = nowIso.split("T")[0];

  // 1. Incentive config
  let incentive = { type: "flat", value: 0 };
  try {
    const eventSnap = await adminDb.collection("events").doc(eventId).get();
    if (eventSnap.exists && eventSnap.data().agentIncentive) {
      incentive = eventSnap.data().agentIncentive;
    }
  } catch (error) {
    fastify.log.error("[agent-sale] Failed to read incentive config (defaulting to 0):", error);
  }

  const incentiveAmount =
    incentive.type === "percentage"
      ? Math.round(((Number(ticketPrice) || 0) * (Number(incentive.value) || 0)) / 100)
      : Number(incentive.value) || 0;

  // 2. Agent daily ledger
  const agentTxnRef = adminDb
    .collection("agents")
    .doc(agentId)
    .collection("transactions")
    .doc(purchaseDateFormatted);

  try {
    const txnDoc = await agentTxnRef.get();
    if (!txnDoc.exists) {
      await agentTxnRef.set({
        events: [{ eventId, eventName: paymentData.eventName }],
        salesCount: totalTicketCount,
        grossSales: Number(ticketPrice) || 0,
        incentiveEarned: incentiveAmount,
        withdrawn: false,
        withdrawnAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } else {
      await agentTxnRef.update({
        // arrayUnion on objects only dedupes exact matches, which is fine —
        // we just want "which events contributed today", not a count.
        events: FieldValue.arrayUnion({ eventId, eventName: paymentData.eventName }),
        salesCount: FieldValue.increment(totalTicketCount),
        grossSales: FieldValue.increment(Number(ticketPrice) || 0),
        incentiveEarned: FieldValue.increment(incentiveAmount),
        updatedAt: nowIso,
      });
    }
    fastify.log.info(
      `[agent-sale] Recorded ₦${incentiveAmount} incentive for agent ${agentId} on ${purchaseDateFormatted}`
    );
  } catch (error) {
    fastify.log.error("[agent-sale] Failed to write agent daily ledger:", error);
  }

  // 3. Flip reserved pool tickets to sold
  const reservedTicketIds = paymentData.reservedTicketIds || [];
  if (paymentData.passMode === "pregenerated" && reservedTicketIds.length > 0) {
    try {
      const batch = adminDb.batch();
      reservedTicketIds.forEach((ticketId) => {
        batch.update(adminDb.collection("agents").doc(agentId).collection(eventId).doc(ticketId), {
          status: "sold",
          soldAt: nowIso,
        });
      });
      await batch.commit();
      fastify.log.info(`[agent-sale] Marked ${reservedTicketIds.length} pool ticket(s) sold for ${agentId}`);
    } catch (error) {
      fastify.log.error("[agent-sale] Failed to flip pool tickets to sold:", error);
    }
  }

  // 4. Purchase history record (for the agent dashboard's "recent
  // purchases" card — buyer email/name, ticket type, event name)
  try {
    await adminDb
      .collection("agents")
      .doc(agentId)
      .collection("purchases")
      .add({
        buyerEmail: paymentData.userEmail || "",
        buyerName: paymentData.userFullName || "Valued Customer",
        ticketType: paymentData.ticketType || (paymentData.ticketTypes?.[0]?.type ?? ""),
        eventName: paymentData.eventName || "",
        eventId,
        quantity: totalTicketCount,
        amount: Number(ticketPrice) || 0,
        createdAt: nowIso,
      });
  } catch (error) {
    fastify.log.error("[agent-sale] Failed to write purchase history record (non-blocking):", error);
  }

  return incentiveAmount;
}
