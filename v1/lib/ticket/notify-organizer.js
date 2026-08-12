// v1/lib/ticket/notify-organizer.js
//
// Step 12 of ticket generation: tell the event organizer on Telegram that a
// sale just happened. Fire-and-forget by design — this function is called
// WITHOUT `await` from index.js, so a slow or unreachable bot service can
// never delay the buyer's ticket response or add latency to the webhook.
// Any failure is caught here and only logged; it never surfaces upstream.

export function notifyOrganizerOfSale(fastify, { eventId, buyerName, ticketSummary, totalAmount, ticketCount, ticketsSold }) {
  const BOT_SERVICE_URL = process.env.BOT_SERVICE_URL || "http://localhost:5000";

  fetch(`${BOT_SERVICE_URL}/notify/ticket-sale`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, buyerName, ticketSummary, totalAmount, ticketCount, ticketsSold }),
  })
    .then((res) => {
      if (!res.ok) {
        fastify.log.warn(`[step:12] Telegram notify failed — status: ${res.status}`);
      } else {
        fastify.log.info("[step:12] Telegram organizer notification sent");
      }
    })
    .catch((error) => {
      fastify.log.error(`[step:12] Telegram notify error (non-blocking): ${error.message}`);
    });
}
