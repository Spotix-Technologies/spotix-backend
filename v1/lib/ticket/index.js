// v1/lib/ticket/index.js
//
// Orchestrates the full ticket-generation pipeline out of the step
// modules in this folder. This is the only file ticket.js needs to
// import from — each numbered step lives in its own file below so the
// flow can be read (and changed) one concern at a time:
//
//   1.  verify-payment-status.js  — confirm payment is "successful"
//   —   claim-lock.js             — atomic claim so only one request generates
//   2-3 build-tickets.js          — expand cart into seats, mint ticket IDs
//   4-5 write-tickets.js          — write tickets/ + attendees/ docs
//   6.  atomic-ops.js             — external stock/discount decrement
//   7.  referral.js               — referral usage tracking
//   7b. agent-sale.js             — agent incentive + pool + ledger
//   8.  admin-sales.js            — booker daily sales aggregation
//   9.  finalize-reference.js     — mark reference complete, release lock
//   9b. survey-delivery.js        — deliver event-survey answers (post-payment only)
//   10. analytics.js              — global analytics reporting
//   11. confirmation-email.js     — buyer confirmation email
//
// All steps after the claim are best-effort / non-blocking: a failure in
// any of them is logged and swallowed so the buyer's ticket is never lost
// over an email, analytics, or referral hiccup.

import { adminDb } from "../../firebase-admin.js";
import { isValidTicketReference } from "../reference-format.js";

import { verifyPaymentStatus } from "./verify-payment-status.js";
import { claimGenerationLock, buildAlreadyGeneratedResult } from "./claim-lock.js";
import { buildTicketSeats, assignTicketIds, generateTicketId } from "./build-tickets.js";
import { writeTicketsAndAttendees } from "./write-tickets.js";
import { runAtomicOps } from "./atomic-ops.js";
import { applyReferralUsage } from "./referral.js";
import { processAgentSale } from "./agent-sale.js";
import { updateAdminDailySales } from "./admin-sales.js";
import { finalizeReference } from "./finalize-reference.js";
import { deliverSurveyResponse } from "./survey-delivery.js";
import { reportAnalytics } from "./analytics.js";
import { sendConfirmationEmail } from "./confirmation-email.js";

// ─── Exported core logic (called by webhook after charge.success) ─────────────
export async function generateTickets(fastify, reference) {
  if (!isValidTicketReference(reference)) {
    throw Object.assign(new Error("Invalid reference format. Expected format: SPTX-REF-{timestamp}-{2 letters}"), {
      statusCode: 400,
    });
  }

  const referenceDocRef = adminDb.collection("Reference").doc(reference);

  // ─── Step 1: Verify payment status with retry logic ─────────────────────────
  let paymentData = await verifyPaymentStatus(fastify, referenceDocRef);

  // ─── Atomic claim: only ONE concurrent request may process this reference ──
  const claim = await claimGenerationLock(adminDb, referenceDocRef, paymentData);
  paymentData = claim.paymentData;

  if (claim.claimResult === "already_generated") {
    fastify.log.info(`[step:guard] ${reference} already generated — returning existing data`);
    return buildAlreadyGeneratedResult(paymentData);
  }

  if (claim.claimResult === "locked") {
    fastify.log.warn(`[step:guard] ${reference} is already being processed — rejecting duplicate request`);
    throw Object.assign(
      new Error("Ticket generation already in progress for this reference. Please wait and refresh."),
      { statusCode: 409 }
    );
  }

  // claim.claimResult === "claimed" — lock is ours, proceed with generation

  const now = new Date();
  const purchaseTime = now.toLocaleTimeString();
  const nowIso = now.toISOString();

  // ─── Resolve buyer identity ──────────────────────────────────────────────────
  const isGuest = !paymentData.userId;
  const effectiveUid = paymentData.userId || paymentData.guestEmail || paymentData.userEmail;

  if (!effectiveUid) {
    throw Object.assign(
      new Error("Cannot resolve buyer identity: no userId or guest email on reference."),
      { statusCode: 400 }
    );
  }

  const buyerFullName = paymentData.userFullName || "Valued Customer";
  const buyerEmail = paymentData.userEmail || paymentData.guestEmail || "";
  const buyerPhone = paymentData.userPhone || paymentData.guestPhone || "";

  // ─── Steps 2-3: Build seats and assign ticket IDs ───────────────────────────
  const { ticketTypesArray, ticketSeats, totalTicketCount } = buildTicketSeats(fastify, paymentData, reference);
  const ticketIds = await assignTicketIds(fastify, adminDb, referenceDocRef, ticketSeats, totalTicketCount);

  // ─── Steps 4-5: Write tickets/{ticketId} and attendees/{ticketId} ───────────
  const createdTicketIds = await writeTicketsAndAttendees(fastify, adminDb, {
    paymentData,
    ticketSeats,
    ticketIds,
    reference,
    buyerFullName,
    buyerEmail,
    buyerPhone,
    isGuest,
    nowIso,
  });

  // ─── Step 6: Atomic operations (stats / discounts) ──────────────────────────
  await runAtomicOps(fastify, paymentData, ticketSeats, ticketIds, ticketTypesArray);

  // ─── Step 7: Update referral usage ──────────────────────────────────────────
  await applyReferralUsage(fastify, adminDb, {
    paymentData,
    createdTicketIds,
    ticketSeats,
    buyerFullName,
    totalTicketCount,
    nowIso,
  });

  // ─── Step 7b: Agent sale processing (incentive + pool + agent ledger) ───────
  let agentIncentiveAmount = 0;
  if (paymentData.isAgentSale && paymentData.agentId) {
    try {
      agentIncentiveAmount = await processAgentSale(fastify, paymentData, totalTicketCount, nowIso);
    } catch (error) {
      fastify.log.error("[step:7b] Agent sale processing error (non-blocking):", error);
    }
  }

  // ─── Step 8: Admin daily sales aggregation ──────────────────────────────────
  await updateAdminDailySales(fastify, adminDb, {
    paymentData,
    totalTicketCount,
    agentIncentiveAmount,
    nowIso,
    purchaseTime,
  });

  // ─── Step 9: Mark reference as fully generated + release lock ───────────────
  await finalizeReference(fastify, referenceDocRef, { createdTicketIds, totalTicketCount, nowIso, reference });

  // ─── Step 9b: Deliver survey response — only now that payment + ticket
  // generation are both confirmed. This is what actually fixes the
  // pay-or-not-pay survey leak: nothing upstream of finalizeReference()
  // can reach this line unless a ticket was really issued.
  await deliverSurveyResponse(fastify, adminDb, paymentData, { buyerFullName, buyerEmail, isGuest });

  // ─── Step 10: Global analytics ──────────────────────────────────────────────
  await reportAnalytics(fastify, paymentData, createdTicketIds, totalTicketCount, nowIso);

  // ─── Step 11: Confirmation email ────────────────────────────────────────────
  await sendConfirmationEmail(fastify, {
    paymentData,
    reference,
    createdTicketIds,
    totalTicketCount,
    ticketTypesArray,
    buyerFullName,
    buyerEmail,
  });

  // ─── Return result ───────────────────────────────────────────────────────────
  return {
    alreadyGenerated: false,
    ticketIds: createdTicketIds,
    totalTickets: totalTicketCount,
    eventId: paymentData.eventId,
    eventName: paymentData.eventName,
    totalAmount: paymentData.totalAmount,
    buyerInfo: { fullName: buyerFullName, email: buyerEmail, isGuest },
    eventDetails: {
      eventVenue: paymentData.eventVenue,
      eventType: paymentData.eventType,
      eventDate: paymentData.eventDate,
      eventEndDate: paymentData.eventEndDate,
      eventStart: paymentData.eventStart,
      eventEnd: paymentData.eventEnd,
      bookerName: paymentData.bookerName,
      bookerEmail: paymentData.bookerEmail,
    },
    discountApplied: !!paymentData.discountCode,
    referralUsed: !!paymentData.referralCode,
  };
}

// Re-exported so ticket.js (and ticket-agent.js, via ticket.js) keep working
// with the exact same import surface as before the split.
export { processAgentSale, generateTicketId };
