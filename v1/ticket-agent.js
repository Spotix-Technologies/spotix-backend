// Agent Ticket Generation Route
// v1/ticket-agent.js
//
// Called instead of v1/ticket.js's generateTickets() specifically for
// pregenerated-pass agent sales (webhook.js decides which one to call,
// based on Reference.isAgentSale && Reference.passMode === "pregenerated").
//
// This is a deliberate near-total duplicate of generateTickets() — every
// step is the same (payment verification, atomic stock ops, referral,
// agent-sale processing, admin aggregation, analytics, email) — with
// exactly one difference: Step 3 assigns the ticketId(s) from
// paymentData.reservedTicketIds (the specific pool passes the agent
// scanned and reserved in POST /api/v1/agent/sale) instead of minting
// fresh random ones. The physical paper the buyer is holding already has
// this ID printed/QR-encoded on it, so the digital ticket record has to
// use the exact same ID or the two won't match at the door.
//
// processAgentSale() and generateTicketId() are imported from ticket.js
// rather than re-duplicated — that logic (incentive calc, pool
// available->sold flip, daily agent ledger) needs to stay byte-identical
// between both routes, so it's shared rather than copy-pasted.

import { adminDb } from "./firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { processAgentSale, generateTicketId } from "./ticket.js";
import { isValidTicketReference } from "./lib/reference-format.js";

export async function generateAgentTickets(fastify, reference) {
  if (!isValidTicketReference(reference)) {
    throw Object.assign(new Error("Invalid reference format. Expected format: SPTX-REF-{timestamp}-{2 letters}"), {
      statusCode: 400,
    });
  }

  // ─── Step 1: Verify payment status with retry logic ─────────────────────────
  let paymentData = null;
  let attempts = 0;
  const maxAttempts = 3;
  const referenceDocRef = adminDb.collection("Reference").doc(reference);

  while (attempts < maxAttempts) {
    const referenceDoc = await referenceDocRef.get();

    if (!referenceDoc.exists) {
      throw Object.assign(new Error("Payment reference not found"), { statusCode: 404 });
    }

    paymentData = referenceDoc.data();

    if (paymentData.status === "successful") {
      break;
    } else if (paymentData.status === "failed") {
      throw Object.assign(
        new Error("Payment verification failed. Please try again or contact support."),
        { statusCode: 400 }
      );
    } else if (paymentData.status === "pending") {
      attempts++;
      if (attempts < maxAttempts) {
        fastify.log.info(`[agent-step:1] Payment pending, retrying (${attempts}/${maxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        throw Object.assign(
          new Error("Payment is still being processed. Please try again in a few moments."),
          { statusCode: 400 }
        );
      }
    }
  }

  if (!paymentData.isAgentSale || !Array.isArray(paymentData.reservedTicketIds) || paymentData.reservedTicketIds.length === 0) {
    throw Object.assign(
      new Error("This reference has no reserved pass(es) — it should not be routed through the agent ticket generator."),
      { statusCode: 400 }
    );
  }

  // ── Defensive guard: if any reserved pass was somehow already sold
  // (e.g. this route got re-triggered manually after a prior success),
  // don't silently re-issue — the pass is the physical, one-time-use
  // ticket a buyer is holding.
  const passRefs = paymentData.reservedTicketIds.map((id) =>
    adminDb.collection("agents").doc(paymentData.agentId).collection(paymentData.eventId).doc(id)
  );
  const passSnaps = await Promise.all(passRefs.map((r) => r.get()));
  const alreadySold = passSnaps.find((s) => s.exists && s.data().status === "sold");
  if (alreadySold && !paymentData.ticketGenerated) {
    throw Object.assign(
      new Error(`Pass ${alreadySold.id} has already been paid for.`),
      { statusCode: 409 }
    );
  }

  // ── Atomic claim: only ONE concurrent request may process this reference ──────
  let claimResult = null;

  await adminDb.runTransaction(async (transaction) => {
    const refDoc = await transaction.get(referenceDocRef);
    if (!refDoc.exists) throw Object.assign(new Error("Payment reference not found"), { statusCode: 404 });

    const data = refDoc.data();

    if (data.ticketGenerated) {
      claimResult = "already_generated";
      paymentData = data;
      return;
    }

    if (data.processingLock) {
      claimResult = "locked";
      return;
    }

    transaction.update(referenceDocRef, {
      processingLock: true,
      processingLockedAt: new Date().toISOString(),
    });
    claimResult = "claimed";
  });

  if (claimResult === "already_generated") {
    fastify.log.info(`[agent-step:guard] ${reference} already generated — returning existing data`);
    return {
      alreadyGenerated: true,
      ticketIds: paymentData.generatedTicketIds || [],
      totalTickets: paymentData.totalTicketsGenerated || 0,
      eventId: paymentData.eventId,
      eventName: paymentData.eventName,
      totalAmount: paymentData.totalAmount || 0,
      buyerInfo: {
        fullName: paymentData.userFullName || "Valued Customer",
        email: paymentData.userEmail || "",
        isGuest: true,
      },
      eventDetails: {
        eventVenue: paymentData.eventVenue || null,
        eventType: paymentData.eventType || null,
        eventDate: paymentData.eventDate || null,
        eventEndDate: paymentData.eventEndDate || null,
        eventStart: paymentData.eventStart || null,
        eventEnd: paymentData.eventEnd || null,
        bookerName: paymentData.bookerName || null,
        bookerEmail: paymentData.bookerEmail || null,
      },
      discountApplied: false,
      referralUsed: false,
    };
  }

  if (claimResult === "locked") {
    fastify.log.warn(`[agent-step:guard] ${reference} is already being processed — rejecting duplicate request`);
    throw Object.assign(
      new Error("Ticket generation already in progress for this reference. Please wait and refresh."),
      { statusCode: 409 }
    );
  }

  const now = new Date();
  const purchaseDate = now.toLocaleDateString();
  const purchaseTime = now.toLocaleTimeString();
  const nowIso = now.toISOString();

  // ─── Resolve buyer identity — agent sales are always guest checkouts ────────
  const isGuest = true;
  const effectiveUid = paymentData.userEmail;

  if (!effectiveUid) {
    throw Object.assign(new Error("Cannot resolve buyer identity: no buyer email on reference."), { statusCode: 400 });
  }

  const buyerFullName = paymentData.userFullName || "Valued Customer";
  const buyerEmail = paymentData.userEmail || "";
  const buyerPhone = paymentData.userPhone || "";

  // ─── Step 2: Build the list of tickets to generate ──────────────────────────
  // Agent sales are always a single ticketType per reference (see
  // agent/sale/route.ts), so ticketTypes has exactly one entry.
  const ticketTypesArray =
    paymentData.ticketTypes && Array.isArray(paymentData.ticketTypes) && paymentData.ticketTypes.length > 0
      ? paymentData.ticketTypes
      : [{ type: paymentData.ticketType, quantity: 1, price: paymentData.ticketPrice }];

  const ticketSeats = [];
  for (const item of ticketTypesArray) {
    const qty = Number(item.quantity) || 1;
    for (let i = 0; i < qty; i++) {
      ticketSeats.push({ type: item.type, price: Number(item.price) || 0 });
    }
  }

  const totalTicketCount = ticketSeats.length;

  if (paymentData.reservedTicketIds.length !== totalTicketCount) {
    throw Object.assign(
      new Error(
        `Reserved pass count (${paymentData.reservedTicketIds.length}) does not match ticket count (${totalTicketCount}) for ${reference}`
      ),
      { statusCode: 500 }
    );
  }

  fastify.log.info(`[agent-step:2] ${totalTicketCount} pass(es) to finalize for ${reference}`);

  // ─── Step 3: ticketIds = the exact passes the agent scanned ──────────────────
  // This is the one real difference from generateTickets() — every other
  // step below is unchanged.
  let ticketIds = [];

  await adminDb.runTransaction(async (transaction) => {
    const refDoc = await transaction.get(referenceDocRef);
    if (!refDoc.exists) throw new Error("Reference document not found during transaction");

    const refData = refDoc.data();

    if (refData.ticketIds && Array.isArray(refData.ticketIds) && refData.ticketIds.length === totalTicketCount) {
      ticketIds = refData.ticketIds;
      fastify.log.info(`[agent-step:3] Reusing existing ticketIds: ${ticketIds.join(", ")}`);
    } else {
      // The pass itself IS the ticketId — no generateTicketId() call here.
      ticketIds = paymentData.reservedTicketIds;
      fastify.log.info(`[agent-step:3] Using scanned pass(es) as ticketIds: ${ticketIds.join(", ")}`);
      transaction.update(referenceDocRef, {
        ticketIds,
        ticketIdGeneratedAt: nowIso,
        updatedAt: nowIso,
      });
    }
  });

  // ─── Shared base fields for every ticket document ───────────────────────────
  const baseTicketFields = {
    uid: effectiveUid,
    isGuest,
    fullName: buyerFullName,
    email: buyerEmail,
    phoneNumber: buyerPhone,
    ticketReference: reference,
    purchaseDate,
    purchaseTime,
    verified: false,
    paymentMethod: "Paystack",
    discountApplied: false,
    discountCode: null,
    referralCode: null,
    referralName: null,
    eventId: paymentData.eventId,
    eventName: paymentData.eventName,
    eventCreatorId: paymentData.eventCreatorId,
    eventVenue: paymentData.eventVenue || null,
    eventType: paymentData.eventType || null,
    eventDate: paymentData.eventDate || null,
    eventEndDate: paymentData.eventEndDate || null,
    eventStart: paymentData.eventStart || null,
    eventEnd: paymentData.eventEnd || null,
    totalAmount: paymentData.totalAmount || 0,
    transactionFee: paymentData.transactionFee || 0,
    // Agent-sale attribution, kept on the ticket/attendee record too so the
    // booker's attendee list can show who sold it.
    isAgentSale: true,
    agentId: paymentData.agentId,
    agentName: paymentData.agentName || null,
    createdAt: nowIso,
  };

  // ─── Steps 4 & 5: Write tickets/{ticketId} and attendees/{ticketId} ─────────
  const createdTicketIds = [];

  for (let i = 0; i < ticketSeats.length; i++) {
    const seat = ticketSeats[i];
    const ticketId = ticketIds[i];

    const ticketDoc = {
      ...baseTicketFields,
      ticketId,
      ticketType: seat.type,
      ticketPrice: seat.price,
      originalPrice: seat.price,
    };

    const ticketRef = adminDb.collection("tickets").doc(ticketId);
    const ticketSnap = await ticketRef.get();
    if (!ticketSnap.exists) {
      await ticketRef.set(ticketDoc);
    } else {
      fastify.log.info(`[agent-step:4] tickets/${ticketId} already exists — skipping`);
    }

    const attendeeRef = adminDb.collection("events").doc(paymentData.eventId).collection("attendees").doc(ticketId);
    const attendeeSnap = await attendeeRef.get();
    if (!attendeeSnap.exists) {
      await attendeeRef.set(ticketDoc);
    } else {
      fastify.log.info(`[agent-step:5] attendees/${ticketId} already exists — skipping`);
    }

    createdTicketIds.push(ticketId);
  }

  fastify.log.info(`[agent-step:4-5] Tickets and attendees written: ${createdTicketIds.join(", ")}`);

  // ─── Step 6: Atomic operations (stats / discounts) ───────────────────────────
  try {
    const ATOMIC_API_URL = process.env.ATOMIC_API_URL;

    if (ATOMIC_API_URL) {
      const typeToFirstTicketId = {};
      for (let i = 0; i < ticketSeats.length; i++) {
        const type = ticketSeats[i].type;
        if (!(type in typeToFirstTicketId)) typeToFirstTicketId[type] = ticketIds[i];
      }

      for (const item of ticketTypesArray) {
        const idempotencyKey = typeToFirstTicketId[item.type] || ticketIds[0];
        const atomicResponse = await fetch(ATOMIC_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticketId: idempotencyKey,
            creatorId: paymentData.eventCreatorId,
            eventId: paymentData.eventId,
            ticketType: item.type,
            ticketPrice: item.price,
            quantity: Number(item.quantity) || 1,
            discountCode: null,
          }),
        });

        if (atomicResponse.ok) {
          const atomicResult = await atomicResponse.json();
          fastify.log.info(
            `[agent-step:6] Atomic ops for type "${item.type}": ${atomicResult.alreadyProcessed ? "already processed" : "done"}`
          );
        } else {
          fastify.log.warn(`[agent-step:6] Atomic API returned ${atomicResponse.status} for type "${item.type}"`);
        }
      }
    } else {
      fastify.log.warn("[agent-step:6] ATOMIC_API_URL not configured — skipping");
    }
  } catch (atomicError) {
    fastify.log.error("[agent-step:6] Atomic operations error (non-blocking):", atomicError);
  }

  // ─── Step 7: Referral usage — agent sales never carry a referral code ───────
  // (kept as a no-op step to preserve the exact same step numbering as
  // ticket.js's generateTickets, per spec: "the exact steps must be observed")

  // ─── Step 7b: Agent sale processing (incentive + pool flip to "sold") ───────
  let agentIncentiveAmount = 0;
  try {
    agentIncentiveAmount = await processAgentSale(fastify, paymentData, totalTicketCount, nowIso);
  } catch (error) {
    fastify.log.error("[agent-step:7b] Agent sale processing error (non-blocking):", error);
  }

  // ─── Step 8: Admin daily sales aggregation ───────────────────────────────────
  const purchaseDateFormatted = nowIso.split("T")[0];
  const adminSalesRef = adminDb.collection("admin").doc("events").collection(paymentData.eventId).doc(purchaseDateFormatted);
  const bookerNetAmount = Math.max(0, (paymentData.totalAmount || 0) - agentIncentiveAmount);

  try {
    const salesDoc = await adminSalesRef.get();
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
    fastify.log.info(`[agent-step:8] Daily sales updated for ${purchaseDateFormatted}`);
  } catch (error) {
    fastify.log.error("[agent-step:8] Daily sales aggregation error (non-blocking):", error);
  }

  // ─── Step 9: Mark reference as fully generated + release lock ───────────────
  await referenceDocRef.update({
    ticketGenerated: true,
    ticketGeneratedAt: nowIso,
    generatedTicketIds: createdTicketIds,
    totalTicketsGenerated: totalTicketCount,
    processingLock: false,
    updatedAt: nowIso,
  });

  fastify.log.info(`[agent-step:9] Reference ${reference} marked complete`);

  // ─── Step 10: Global analytics ───────────────────────────────────────────────
  try {
    const ANALYTICS_FUNCTION_URL = process.env.ANALYTICS_FUNCTION_URL;

    if (ANALYTICS_FUNCTION_URL) {
      const analyticsResponse = await fetch(ANALYTICS_FUNCTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketPrice: paymentData.totalAmount ?? paymentData.ticketPrice ?? 0,
          ticketId: createdTicketIds[0],
          ticketCount: totalTicketCount,
          transactionFee: paymentData.transactionFee || 0,
          eventId: paymentData.eventId,
          timestamp: nowIso,
        }),
      });

      if (analyticsResponse.ok) {
        const analyticsResult = await analyticsResponse.json();
        fastify.log.info(`[agent-step:10] Analytics: ${analyticsResult.alreadyProcessed ? "already processed" : "updated"}`);
      } else {
        fastify.log.warn("[agent-step:10] Analytics update failed — tickets still created");
      }
    } else {
      fastify.log.warn("[agent-step:10] ANALYTICS_FUNCTION_URL not configured — skipping");
    }
  } catch (analyticsError) {
    fastify.log.error("[agent-step:10] Analytics error (non-blocking):", analyticsError);
  }

  // ─── Step 11: Confirmation email ─────────────────────────────────────────────
  try {
    const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:2000";
    const ticketTypeSummary = ticketTypesArray
      .map((item) => `${item.type}${Number(item.quantity) > 1 ? ` x${item.quantity}` : ""}`)
      .join(", ");
    // createdTicketIds and ticketSeats share the same seat-order loop above,
    // so index i is the same physical ticket in both arrays.
    const tickets = createdTicketIds.map((ticketId, i) => ({
      ticketId,
      ticketType: ticketSeats?.[i]?.type || "Standard",
    }));
    const emailPayload = {
      email: buyerEmail,
      name: buyerFullName || "Valued Customer",
      tickets,
      ticket_references: reference,
      event_host: paymentData.bookerName || "Event Host",
      event_name: paymentData.eventName,
      payment_ref: reference,
      ticket_types: ticketTypeSummary,
      booker_email: paymentData.bookerEmail || "support@spotix.com.ng",
      total_amount: (paymentData.totalAmount).toFixed(2),
      ticket_count: totalTicketCount,
      payment_method: "Paystack",
    };

    const emailResponse = await fetch(`${BACKEND_URL}/v1/mail/payment-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(emailPayload),
    });

    if (emailResponse.ok) {
      fastify.log.info("[agent-step:11] Confirmation email sent");
    } else {
      const responseBody = await emailResponse.text();
      fastify.log.warn(`[agent-step:11] Email failed — status: ${emailResponse.status} | body: ${responseBody}`);
    }
  } catch (error) {
    fastify.log.error(`[agent-step:11] Email error (non-blocking): ${error.message}`, { stack: error.stack });
  }

  // ─── Return result ────────────────────────────────────────────────────────────
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
    discountApplied: false,
    referralUsed: false,
  };
}

// ─── Fastify route (frontend-triggered fallback / manual re-generation) ───────
export default async function ticketAgentRoute(fastify, options) {
  fastify.post("/ticket/agent", async (request, reply) => {
    try {
      const { reference } = request.body;

      if (!reference) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Missing required parameter: reference",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      const result = await generateAgentTickets(fastify, reference);

      return reply.code(200).send({
        success: true,
        message: result.alreadyGenerated ? "Tickets were already generated" : `${result.totalTickets} ticket(s) generated successfully`,
        ticketIds: result.ticketIds,
        ticketReference: reference,
        totalTickets: result.totalTickets,
        eventId: result.eventId,
        eventName: result.eventName,
        totalAmount: result.totalAmount,
        buyerInfo: result.buyerInfo,
        eventDetails: result.eventDetails,
        discountApplied: result.discountApplied,
        referralUsed: result.referralUsed,
        developer: "API developed and maintained by Spotix Technologies",
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      fastify.log.error("Agent ticket generation error:", error?.message);
      fastify.log.error("Stack:", error?.stack);
      return reply.code(statusCode).send({
        error: statusCode === 500 ? "Internal Server Error" : "Request Error",
        message: error?.message || "Failed to generate ticket",
        developer: "API developed and maintained by Spotix Technologies",
      });
    }
  });

  fastify.get("/ticket/agent/health", async (request, reply) => {
    return reply.code(200).send({
      status: "healthy",
      service: "Agent Ticket Generation API",
      timestamp: new Date().toISOString(),
      developer: "API developed and maintained by Spotix Technologies",
    });
  });
}

export { generateTicketId };
