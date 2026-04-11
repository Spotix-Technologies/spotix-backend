import crypto from "crypto";
import { adminDb } from "./firebase-admin.js";
import { processTransferEvents } from "./payout.js";

const TRANSFER_EVENTS = new Set([
  "transfer.success",
  "transfer.failed",
  "transfer.reversed",
]);

export default async function webhookRoute(fastify, options) {
  fastify.post("/webhook", async (request, reply) => {
    try {
      const paystackSecret = process.env.PAYSTACK_SECRET_KEY;
      if (!paystackSecret) {
        fastify.log.error("PAYSTACK_SECRET_KEY not configured");
        return reply.code(500).send({ error: "Server configuration error" });
      }

      // ── Signature verification ─────────────────────────────────────────────
      const hash = crypto
        .createHmac("sha512", paystackSecret)
        .update(JSON.stringify(request.body))
        .digest("hex");

      if (hash !== request.headers["x-paystack-signature"]) {
        fastify.log.warn("[webhook] Invalid Paystack signature");
        return reply.code(401).send({ error: "Invalid signature" });
      }

      const { event, data } = request.body;
      fastify.log.info(`[webhook] Received event: ${event}`);

      // ── Ticket purchase ────────────────────────────────────────────────────
      if (event === "charge.success" || event === "charge.failed") {
        const reference = data?.reference;
        if (!reference) {
          return reply.code(400).send({ error: "Missing reference" });
        }

        const transactionType = data?.metadata?.custom_fields?.find(
          (f) => f.variable_name === "type"
        )?.value;

        if (transactionType !== "ticket_purchase") {
          fastify.log.info(`[webhook] Skipping non-ticket charge: ${transactionType}`);
          return reply.code(200).send({ success: true, message: "Not a ticket purchase" });
        }

        const paymentStatus = event === "charge.success" ? "successful" : "failed";

        try {
          const referenceRef = adminDb.collection("Reference").doc(reference);
          const referenceDoc = await referenceRef.get();

          if (!referenceDoc.exists) {
            fastify.log.warn(`[webhook] Reference not found: ${reference}`);
            return reply.code(404).send({ error: "Reference not found", reference });
          }

          await referenceRef.update({
            status: paymentStatus,
            updatedAt: new Date().toISOString(),
            paystackEvent: event,
            transactionType: "ticket_purchase",
            amount: data?.amount ?? null,
            currency: data?.currency ?? null,
            customer: {
              email: data?.customer?.email ?? null,
              customerCode: data?.customer?.customer_code ?? null,
            },
          });

          fastify.log.info(`[webhook] Ticket purchase ${reference} → ${paymentStatus}`);
          return reply.code(200).send({ success: true, reference, status: paymentStatus });
        } catch (err) {
          fastify.log.error("[webhook] Firestore error on ticket purchase:", err);
          return reply.code(500).send({ error: "Database update failed" });
        }
      }

      // ── Transfer events (payout cycle) ────────────────────────────────────
      if (TRANSFER_EVENTS.has(event)) {
        try {
          await processTransferEvents(fastify, [{ event, data }]);
          return reply.code(200).send({ success: true, event });
        } catch (err) {
          fastify.log.error("[webhook] processTransferEvents error:", err);
          // Still return 200 — Paystack must not retry due to our internal error
          return reply.code(200).send({ success: false, error: "Internal processing error" });
        }
      }

      // ── Unhandled events ───────────────────────────────────────────────────
      fastify.log.info(`[webhook] Unhandled event: ${event}`);
      return reply.code(200).send({ success: true, message: "Event received but not processed" });

    } catch (error) {
      fastify.log.error("[webhook] Unhandled error:", error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  fastify.get("/webhook/health", async (request, reply) => {
    return reply.code(200).send({
      status: "active",
      service: "Paystack Webhook Handler",
      developer: "Developed by Spotix Technologies",
      timestamp: new Date().toISOString(),
    });
  });
}
