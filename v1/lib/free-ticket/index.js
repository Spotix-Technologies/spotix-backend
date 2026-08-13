// v1/lib/free-ticket/index.js
//
// Orchestrates free-ticket generation out of the exact same step modules
// v1/lib/ticket/index.js uses for paid tickets. This is possible because
// /api/v1/ref/free writes a Reference doc with the identical shape a paid
// reference has — ticketTypes, eventId, buyer info, discount/referral
// fields — just with every money field forced to 0 and status set to
// "successful" immediately (see ref/free/route.ts: "Identical to
// /api/v1/create-pay-ref except all monetary fields are forced to 0").
// Since the shape matches, ticket writing, referral tracking, atomic ops,
// admin aggregation, survey delivery, analytics, and notifications are all
// identical logic — reusing those modules means a fix to any of them
// (e.g. the referral usages subcollection) applies to both pipelines at
// once, instead of needing to be duplicated and kept in sync by hand,
// which is how the old, standalone ticket2.js drifted out of date (it was
// still writing to TicketHistory/{userId}/tickets instead of the current
// tickets/{ticketId} collection, and to a stale nested attendees path).
//
// Only step 1 is genuinely free-specific: verify-free-reference.js (this
// folder) replaces verify-payment-status.js, since there's no payment
// gateway webhook race to poll for — see that file for why.
//
//   1.  verify-free-reference.js  — confirm this is a real, zero-amount, settled reference
//   —   claim-lock.js             — atomic claim so only one request generates       (shared)
//   2-3 build-tickets.js          — expand cart into seats, mint ticket IDs          (shared)
//   4-5 write-tickets.js          — write tickets/ + attendees/ docs                 (shared)
//   6.  atomic-ops.js             — external stock/discount decrement               (shared)
//   7.  referral.js               — referral usage tracking (subcollection)         (shared)
//   7b. agent-sale.js             — agent incentive, if this free ticket was agent-issued (shared)
//   8.  admin-sales.js            — booker daily sales aggregation                  (shared)
//   9.  finalize-reference.js     — mark reference complete, release lock           (shared)
//   9b. survey-delivery.js        — deliver event-survey answers                    (shared)
//   10. analytics.js              — global analytics reporting                      (shared)
//   11. confirmation-email.js     — buyer confirmation email                        (shared)
//   12. notify-organizer.js       — Telegram sale ping to the event organizer       (shared)
//
// Every step after the claim is best-effort / non-blocking, same guarantee
// as the paid pipeline: a failure in any of them is logged and swallowed
// so the buyer's free ticket is never lost over an email, analytics, or
// referral hiccup.

import { adminDb } from "../../firebase-admin.js";
import { isValidTicketReference } from "../reference-format.js";

import { verifyFreeReference } from "./verify-free-reference.js";
import { claimGenerationLock, buildAlreadyGeneratedResult } from "../ticket/claim-lock.js";
import { buildTicketSeats, assignTicketIds } from "../ticket/build-tickets.js";
import { writeTicketsAndAttendees } from "../ticket/write-tickets.js";
import { runAtomicOps } from "../ticket/atomic-ops.js";
import { applyReferralUsage } from "../ticket/referral.js";
import { processAgentSale } from "../ticket/agent-sale.js";
import { updateAdminDailySales } from "../ticket/admin-sales.js";
import { finalizeReference } from "../ticket/finalize-reference.js";
import { deliverSurveyResponse } from "../ticket/survey-delivery.js";
import { reportAnalytics } from "../ticket/analytics.js";
import { sendConfirmationEmail } from "../ticket/confirmation-email.js";
import { notifyOrganizerOfSale } from "../ticket/notify-organizer.js";

export async function generateFreeTicket(fastify, reference) {
  if (!isValidTicketReference(reference)) {
    throw Object.assign(new Error("Invalid reference format. Expected format: SPTX-REF-{timestamp}-{2 letters}"), {
      statusCode: 400,
    });
  }

  const referenceDocRef = adminDb.collection("Reference").doc(reference);

  // ─── Step 1: Confirm this is a real, zero-amount, settled reference ────────
  let paymentData = await verifyFreeReference(referenceDocRef);

  // ─── Atomic claim: only ONE concurrent request may process this reference ──
  const claim = await claimGenerationLock(adminDb, referenceDocRef, paymentData);
  paymentData = claim.paymentData;

  if (claim.claimResult === "already_generated") {
    fastify.log.info(`[free:guard] ${reference} already generated — returning existing data`);
    return buildAlreadyGeneratedResult(paymentData);
  }

  if (claim.claimResult === "locked") {
    fastify.log.warn(`[free:guard] ${reference} is already being processed — rejecting duplicate request`);
    throw Object.assign(
      new Error("Ticket generation already in progress for this reference. Please wait and refresh."),
      { statusCode: 409 }
    );
  }

  // claim.claimResult === "claimed" — lock is ours, proceed with generation

  const now = new Date();
  const purchaseTime = now.toLocaleTimeString();
  const nowIso = now.toISOString();

  // ─── Resolve buyer identity — guests included, unlike the old ticket2.js
  // which required paymentData.userId and hard-404'd otherwise, breaking
  // free-ticket generation for guest checkouts entirely. ──────────────────
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

  // ─── Steps 2-3: Build seats and assign ticket IDs — also adds support for
  // multi-ticket-type / multi-quantity free carts, which the old ticket2.js
  // never handled (it only ever read a single paymentData.ticketType). ────
  const { ticketTypesArray, ticketSeats, totalTicketCount } = buildTicketSeats(fastify, paymentData, reference);
  const ticketIds = await assignTicketIds(fastify, adminDb, referenceDocRef, ticketSeats, totalTicketCount);

  // ─── Steps 4-5: Write tickets/{ticketId} and attendees/{ticketId} ───────
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

  // ─── Step 6: Atomic operations (stock decrement; price is 0 so revenue
  // stats are unaffected, but ticket-type stock still needs to move) ──────
  await runAtomicOps(fastify, paymentData, ticketSeats, ticketIds, ticketTypesArray);

  // ─── Step 7: Update referral usage (writes to the usages subcollection) ─
  await applyReferralUsage(fastify, adminDb, {
    paymentData,
    createdTicketIds,
    ticketSeats,
    buyerFullName,
    totalTicketCount,
    nowIso,
  });

  // ─── Step 7b: Agent sale processing — free events can still be agent-
  // issued (allowAgents on the event isn't price-gated), so this stays
  // guarded the same way the paid pipeline guards it. Incentive amount
  // will simply come out to 0 for a "percentage" config since ticketPrice
  // is 0; a "flat" incentive config still pays out normally. ─────────────
  let agentIncentiveAmount = 0;
  if (paymentData.isAgentSale && paymentData.agentId) {
    try {
      agentIncentiveAmount = await processAgentSale(fastify, paymentData, totalTicketCount, nowIso);
    } catch (error) {
      fastify.log.error("[free:7b] Agent sale processing error (non-blocking):", error);
    }
  }

  // ─── Step 8: Admin daily sales aggregation (ticketSales lands as 0, but
  // ticketCount still matters to the booker) ───────────────────────────────
  await updateAdminDailySales(fastify, adminDb, {
    paymentData,
    totalTicketCount,
    agentIncentiveAmount,
    nowIso,
    purchaseTime,
  });

  // ─── Step 9: Mark reference as fully generated + release lock ───────────
  await finalizeReference(fastify, referenceDocRef, { createdTicketIds, totalTicketCount, nowIso, reference });

  // ─── Step 9b: Deliver survey response, now that the ticket is confirmed
  // issued — the old ticket2.js never delivered survey responses at all,
  // so any survey attached to a free-ticket checkout silently vanished. ───
  await deliverSurveyResponse(fastify, adminDb, paymentData, { buyerFullName, buyerEmail, isGuest });

  // ─── Step 10: Global analytics (ticketPrice reports as 0) ───────────────
  await reportAnalytics(fastify, paymentData, createdTicketIds, totalTicketCount, nowIso);

  // ─── Step 11: Confirmation email ────────────────────────────────────────
  await sendConfirmationEmail(fastify, {
    paymentData,
    reference,
    createdTicketIds,
    totalTicketCount,
    ticketTypesArray,
    buyerFullName,
    buyerEmail,
  });

  // ─── Step 12: Telegram sale notification to organizer — deliberately NOT
  // awaited, same as the paid pipeline (see notify-organizer.js). ─────────
  const ticketTypeSummary = ticketTypesArray
    .map((item) => `${item.type}${Number(item.quantity) > 1 ? ` x${item.quantity}` : ""}`)
    .join(", ");
  notifyOrganizerOfSale(fastify, {
    eventId: paymentData.eventId,
    buyerName: buyerFullName,
    ticketSummary: ticketTypeSummary,
    totalAmount: 0,
    ticketCount: totalTicketCount,
  });

  // ─── Return result ───────────────────────────────────────────────────────
  return {
    alreadyGenerated: false,
    ticketIds: createdTicketIds,
    totalTickets: totalTicketCount,
    eventId: paymentData.eventId,
    eventName: paymentData.eventName,
    totalAmount: 0,
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
    discountApplied: false,
    referralUsed: !!paymentData.referralCode,
  };
}
