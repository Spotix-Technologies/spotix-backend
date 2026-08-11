/**
 * v1/webhook.js
 *
 * Paystack Webhook Handler
 *
 * Handles:
 *   charge.success / charge.failed  (ticket_purchase)
 *   charge.success / charge.failed  (voting_purchase)  
 *   transfer.*                       (payout cycle)
 */

import crypto from "crypto";
import { adminDb } from "./firebase-admin.js";
import { processTransferEvents } from "./payout.js";
import { generateTickets } from "./ticket.js";
import { generateAgentTickets } from "./ticket-agent.js";
import { processVotingCharge } from "./voting.js";          

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

      // ── Charge events ──────────────────────────────────────────────────────
      if (event === "charge.success" || event === "charge.failed") {
        const reference = data?.reference;
        if (!reference) {
          return reply.code(400).send({ error: "Missing reference" });
        }

        // Resolve transaction type from metadata custom_fields
        const transactionType = data?.metadata?.custom_fields?.find(
          (f) => f.variable_name === "type"
        )?.value;

        // ── Ticket purchase ────────────────────────────────────────────────
        if (transactionType === "ticket_purchase") {
          const paymentStatus = event === "charge.success" ? "successful" : "failed";

          try {
            const referenceRef = adminDb.collection("Reference").doc(reference);
            const referenceDoc = await referenceRef.get();

            if (!referenceDoc.exists) {
              fastify.log.warn(`[webhook] Reference not found: ${reference}`);
              return reply.code(404).send({ error: "Reference not found", reference });
            }

            const referenceUpdate = {
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
            };

            // Mirror the voting pipeline's markReferenceStatus: capture
            // Paystack's actual gateway response text (e.g. "Incorrect
            // amount sent" for a dedicated-virtual-account under/overpay)
            // on failure, so downstream consumers (verify-payment-status,
            // the frontend's incorrect_payment detection) have something
            // real to work with instead of just "failed".
            if (paymentStatus === "successful") {
              referenceUpdate.paymentCompletedAt = new Date().toISOString();
            } else {
              referenceUpdate.failureReason = data?.gateway_response ?? "Payment failed";
              referenceUpdate.paymentFailedAt = new Date().toISOString();
            }

            await referenceRef.update(referenceUpdate);

            fastify.log.info(`[webhook] Ticket purchase ${reference} → ${paymentStatus}`);

            if (event === "charge.success") {
              try {
                const refData = referenceDoc.data();
                // Pregenerated-pass agent sales must reuse the exact pass
                // ID(s) the agent scanned as the ticketId — that's what's
                // physically printed on the paper the buyer is holding.
                // Everything else (self-service, unrestricted-mode agent
                // sales with no physical pass) goes through the normal
                // generator, which mints a fresh SPTX-TX- id.
                const useAgentGenerator = refData?.isAgentSale && refData?.passMode === "pregenerated";
                const result = useAgentGenerator
                  ? await generateAgentTickets(fastify, reference)
                  : await generateTickets(fastify, reference);
                if (result.alreadyGenerated) {
                  fastify.log.info(`[webhook] Tickets for ${reference} already generated — skipped`);
                } else {
                  fastify.log.info(
                    `[webhook] Generated ${result.totalTickets} ticket(s) for ${reference}: ${result.ticketIds.join(", ")}`
                  );
                }
              } catch (ticketErr) {
                fastify.log.error(
                  `[webhook] Ticket generation failed for ${reference} (non-blocking):`,
                  ticketErr
                );
              }
            }

            return reply.code(200).send({ success: true, reference, status: paymentStatus });
          } catch (err) {
            fastify.log.error("[webhook] Firestore error on ticket purchase:", err);
            return reply.code(500).send({ error: "Database update failed" });
          }
        }

        // ── Voting purchase ────────────────────────────────────────────────
        if (transactionType === "voting_purchase") {
          try {
            const result = await processVotingCharge(fastify, event, data, reference);
            return reply.code(200).send({ success: true, ...result });
          } catch (err) {
            fastify.log.error("[webhook] processVotingCharge error:", err);
            return reply.code(500).send({ error: "Vote processing failed" });
          }
        }

        // ── Unknown charge type ────────────────────────────────────────────
        fastify.log.info(`[webhook] Skipping unrecognised charge type: ${transactionType}`);
        return reply.code(200).send({ success: true, message: "Charge type not handled" });
      }

      // ── Transfer events (payout cycle) ────────────────────────────────────
      if (TRANSFER_EVENTS.has(event)) {
        try {
          await processTransferEvents(fastify, [{ event, data }]);
          return reply.code(200).send({ success: true, event });
        } catch (err) {
          fastify.log.error("[webhook] processTransferEvents error:", err);
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
