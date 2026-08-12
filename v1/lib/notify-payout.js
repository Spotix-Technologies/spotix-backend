// v1/lib/notify-payout.js
//
// Fire-and-forget call to the bot service's Telegram payout-status
// notification route. Used by both v1/payout.js (transfer.success/failed/
// reversed from the Paystack webhook) and v1/cron/payout.js (the
// "processing" flip after a bulk transfer is submitted).
//
// Never call this with `await` — a slow or unreachable bot service must
// never delay the webhook response or the cron job's reply.

export function notifyPayoutStatus(fastify, { userId, status, eventId, date, failureReason }) {
  const BOT_SERVICE_URL = process.env.BOT_SERVICE_URL || "http://localhost:5000"

  fetch(`${BOT_SERVICE_URL}/notify/payout-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, status, eventId, date, failureReason }),
  })
    .then((res) => {
      if (!res.ok) {
        fastify.log.warn(`[payout-notify] Telegram notify failed — status: ${res.status}`)
      } else {
        fastify.log.info(`[payout-notify] Telegram payout notification sent (${status})`)
      }
    })
    .catch((error) => {
      fastify.log.error(`[payout-notify] Telegram notify error (non-blocking): ${error.message}`)
    })
}
