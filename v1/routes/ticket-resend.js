// v1/routes/ticket-resend.js
//
// POST /v1/ticket/resend   { eventId, query }
//
// Powers the "Find my ticket" sheet on the event page. `query` is an email
// address or a ticket payment reference. If that buyer is in the event's
// register, ALL their tickets for the event are emailed to them in one
// message (see v1/lib/ticket/resend-tickets.js).
//
// Privacy: the response is deliberately identical whether or not anything
// matched, and the lookup + send happens AFTER the response is sent, so
// neither the body nor the response time reveals whether an email or
// reference is in a register. Only malformed requests (400) and rate-limited
// ones (429) are distinguishable.

import { resendTicketsForEvent } from "../lib/ticket/resend-tickets.js";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit.js";

// Per IP: 5 lookups / 10 minutes. (The per-buyer 5-minute cooldown lives in resend-tickets.js.)
const IP_WINDOW_SECONDS = 10 * 60;
const IP_MAX_REQUESTS = 5;

export default async function ticketResendRoute(fastify, options) {
  fastify.post("/ticket/resend", async (request, reply) => {
    const { eventId, query } = request.body || {};

    if (typeof eventId !== "string" || typeof query !== "string" || !eventId.trim() || !query.trim()) {
      return reply.code(400).send({ success: false, message: "Missing eventId or email / payment reference." });
    }
    if (eventId.length > 128 || query.length > 254) {
      return reply.code(400).send({ success: false, message: "Invalid request." });
    }

    const { allowed } = await checkRateLimit("ticket-resend", getClientIp(request), IP_WINDOW_SECONDS, IP_MAX_REQUESTS);
    if (!allowed) {
      reply.header("Retry-After", IP_WINDOW_SECONDS);
      return reply.code(429).send({
        success: false,
        error: "rate_limited",
        message: "Too many attempts. Please wait a few minutes and try again.",
      });
    }

    // Fire-and-forget: errors are logged, never surfaced (see header comment).
    resendTicketsForEvent(fastify, { eventId: eventId.trim(), query: query.trim() })
      .then((result) => {
        if (!result.sent) fastify.log.info(`[ticket-resend] nothing sent (${result.reason})`);
      })
      .catch((err) => fastify.log.error(`[ticket-resend] failed: ${err.message}`, { stack: err.stack }));

    return reply.code(200).send({
      success: true,
      message: "If we find this in the event's register, we will email the tickets to the address on them.",
    });
  });
}
