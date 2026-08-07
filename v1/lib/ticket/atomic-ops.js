// v1/lib/ticket/atomic-ops.js
//
// Step 6 of ticket generation: call the external ATOMIC_API_URL to apply
// race-condition-safe stock/discount decrements per ticket type. Entirely
// non-blocking — tickets are already written by this point, so a failure
// here logs a warning and generation continues.

export async function runAtomicOps(fastify, paymentData, ticketSeats, ticketIds, ticketTypesArray) {
  try {
    const ATOMIC_API_URL = process.env.ATOMIC_API_URL;

    if (!ATOMIC_API_URL) {
      fastify.log.warn("[step:6] ATOMIC_API_URL not configured — skipping");
      return;
    }

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
          discountCode: paymentData.discountCode || null,
        }),
      });

      if (atomicResponse.ok) {
        const atomicResult = await atomicResponse.json();
        fastify.log.info(
          `[step:6] Atomic ops for type "${item.type}": ${atomicResult.alreadyProcessed ? "already processed" : "done"}`
        );
      } else {
        fastify.log.warn(`[step:6] Atomic API returned ${atomicResponse.status} for type "${item.type}"`);
      }
    }
  } catch (atomicError) {
    fastify.log.error("[step:6] Atomic operations error (non-blocking):", atomicError);
  }
}
