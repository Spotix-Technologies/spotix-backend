// v1/routes/affiliate.js
//
// POST /v1/affiliate/withdraw
//   Header: x-internal-secret: <CRON_SECRET>   (spotix-affiliates' server only)
//   Body:   { affiliateCode, uid, kind: "event" | "referral", eventId?, methodId }
//
// The browser never reaches this route. spotix-affiliates authenticates the
// affiliate, then calls it server-to-server. The amount is never accepted
// from the caller — see lib/affiliate/withdraw.js.

import { requireInternalSecret } from "../lib/internal-auth.js";
import { checkRateLimit } from "../middleware/rate-limit.js";
import { withdraw, reconcileWithdrawal, WithdrawError } from "../lib/affiliate/withdraw.js";

export default async function affiliateRoute(fastify) {
  fastify.post("/affiliate/withdraw", async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;

    const body = request.body || {};

    // Per-affiliate limiter on top of the global per-IP one.
    const rl = await checkRateLimit("affiliate-withdraw", String(body.affiliateCode || "unknown"), 60, 5);
    if (!rl.allowed) {
      return reply.code(429).send({ success: false, error: "rate_limited", message: "Too many attempts. Please wait a minute." });
    }

    try {
      const result = await withdraw(fastify, body);
      return reply.code(202).send({ success: true, ...result });
    } catch (err) {
      if (err instanceof WithdrawError) {
        return reply.code(err.status).send({ success: false, error: err.code, message: err.message, ...err.extra });
      }
      fastify.log.error({ err }, "[affiliate/withdraw] unexpected error");
      return reply.code(500).send({ success: false, error: "INTERNAL", message: "Something went wrong. Please try again." });
    }
  });

  // POST /v1/affiliate/reconcile  { reference }  — settle a stuck "processing"
  // withdrawal by asking Paystack directly (internal secret, same as above).
  fastify.post("/affiliate/reconcile", async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;
    const { reference } = request.body || {};
    try {
      const result = await reconcileWithdrawal(fastify, reference);
      return reply.send({ success: true, ...result });
    } catch (err) {
      if (err instanceof WithdrawError) {
        return reply.code(err.status).send({ success: false, error: err.code, message: err.message });
      }
      fastify.log.error({ err }, "[affiliate/reconcile] unexpected error");
      return reply.code(500).send({ success: false, error: "INTERNAL", message: "Something went wrong." });
    }
  });
}
