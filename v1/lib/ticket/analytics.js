// v1/lib/ticket/analytics.js
//
// Step 10 of ticket generation: report the sale to the global analytics
// function, if configured. Entirely non-blocking — tickets already exist
// by this point regardless of what happens here.

export async function reportAnalytics(fastify, paymentData, createdTicketIds, totalTicketCount, nowIso) {
  try {
    const ANALYTICS_FUNCTION_URL = process.env.ANALYTICS_FUNCTION_URL;

    if (!ANALYTICS_FUNCTION_URL) {
      fastify.log.warn("[step:10] ANALYTICS_FUNCTION_URL not configured — skipping");
      return;
    }

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
      fastify.log.info(
        `[step:10] Analytics: ${analyticsResult.alreadyProcessed ? "already processed" : "updated"}`
      );
    } else {
      fastify.log.warn("[step:10] Analytics update failed — tickets still created");
    }
  } catch (analyticsError) {
    fastify.log.error("[step:10] Analytics error (non-blocking):", analyticsError);
  }
}
