/**
 * v1/payout-process.js
 *
 * POST /v1/payout/process
 *   Body: { reference }
 *   Header: x-internal-secret: <CRON_SECRET>
 *
 * Internal, service-to-service only — called by spotix-booker
 * immediately after it inserts a Supabase `payouts` row with
 * status="initializing" (all Firebase business-rule checks already
 * passed at that point). Never called from the browser.
 *
 * Reuses CRON_SECRET as the shared internal secret — the old cron job
 * that secret protected is gone, but the "only our own trusted services
 * may hit this" contract is the same one, so there's no need for a
 * second secret.
 *
 * Booker calls this fire-and-forget (doesn't await the result to render
 * its response) — the actual state machine lives in Supabase, and the
 * client watches it live via GET /v1/payout/stream. This route responds
 * quickly with 202 once the reference is confirmed claimable-looking;
 * the real Paystack call happens in processPayoutReference().
 */

import { processPayoutReference } from "./lib/payout/process.js";
import { isValidPayoutReference } from "./lib/payout/reference.js";

export default async function payoutProcessRoute(fastify, options) {
  fastify.post("/payout/process", async (request, reply) => {
    const secret = request.headers["x-internal-secret"];
    if (!secret || secret !== process.env.CRON_SECRET) {
      fastify.log.warn("[payout/process] Unauthorized — missing/incorrect internal secret");
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { reference } = request.body || {};
    if (!isValidPayoutReference(reference)) {
      return reply.code(400).send({ error: "Missing or malformed reference" });
    }

    // Respond immediately — the caller doesn't need to wait on Paystack.
    reply.code(202).send({ success: true, message: "Processing started", reference });

    try {
      const result = await processPayoutReference(fastify, reference);
      fastify.log.info({ result }, `[payout/process] ${reference} → ${JSON.stringify(result)}`);
    } catch (err) {
      fastify.log.error({ err }, `[payout/process] Unhandled error processing ${reference}`);
    }
  });
}
