// v1/verify-payment.js
//
// Payment Verification / Reconciliation Route
//
// GET /verify-payment?ref={reference}
//
// Deliberately simple: given a reference, ask Paystack directly whether
// the transaction actually went through, and if so, update the Reference
// collection and hand off to the exact same pipeline the webhook uses
// (generateTickets / generateAgentTickets / processVotingCharge) so the
// ticket/vote actually gets credited — not just the status field.
//
// This exists for the case where Paystack's webhook is late, dropped, or
// the buyer closes the tab before it lands: the frontend's callback page
// calls this once to force a real check against Paystack instead of just
// re-reading a Firestore doc that nothing has updated yet.
//
// Rate limited (Upstash Redis, the same instance already used for cache
// invalidation in v1/redis.js) because every hit here costs a real call
// to Paystack's API — this endpoint is as much a Paystack-quota guard as
// it is abuse protection.

import fetch from "node-fetch";
import { adminDb } from "./firebase-admin.js";
import { redis } from "./redis.js";
import { isValidTicketReference, isValidVoteReference } from "./lib/reference-format.js";
import { generateTickets } from "./lib/ticket/index.js";
import { generateAgentTickets } from "./ticket-agent.js";
import { processVotingCharge } from "./voting.js";

// ── Rate limiting config ────────────────────────────────────────────────────
const IP_WINDOW_SECONDS = 60;     // per-IP fixed window
const IP_MAX_REQUESTS = 12;       // ~1 every 5s — generous for a polling UI, tight for abuse
const REF_COOLDOWN_SECONDS = 5;   // don't hit Paystack for the same ref faster than this,
                                  // even from different IPs/tabs

async function checkIpRateLimit(ip) {
  const key = `verify-payment:rl:ip:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, IP_WINDOW_SECONDS);
  }
  return count <= IP_MAX_REQUESTS;
}

async function claimRefCooldown(reference) {
  const key = `verify-payment:rl:ref:${reference}`;
  // NX — only succeeds if no cooldown is currently set for this reference
  const set = await redis.set(key, "1", { nx: true, ex: REF_COOLDOWN_SECONDS });
  return set !== null;
}

function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return request.ip;
}

async function verifyWithPaystack(reference, secretKey) {
  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${secretKey}` },
    }
  );
  return response.json(); // { status: bool, message, data: { status, amount, currency, customer, gateway_response, ... } }
}

export default async function verifyPaymentRoute(fastify, options) {
  fastify.get("/verify-payment", async (request, reply) => {
    try {
      // ── Query param validation ──────────────────────────────────────────────
      const { ref } = request.query;

      const allowedParams = ["ref"];
      const foreignParams = Object.keys(request.query).filter((key) => !allowedParams.includes(key));
      if (foreignParams.length > 0) {
        return reply.code(400).send({
          error: "Bad Request",
          message: `Invalid parameter(s): ${foreignParams.join(", ")}`,
          allowedParameters: allowedParams,
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      if (!ref) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Missing required parameter: ref",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      const isTicketRef = isValidTicketReference(ref);
      const isVoteRef = isValidVoteReference(ref);

      if (!isTicketRef && !isVoteRef) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Invalid reference format. Expected SPTX-REF-{timestamp}-{2 letters} or sptx-vt-{timestamp}-{2 letters}.",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      // ── Rate limiting ────────────────────────────────────────────────────────
      // A Redis hiccup should never block a legitimate payment check, so
      // failures here are logged and swallowed (fail-open).
      try {
        const withinIpLimit = await checkIpRateLimit(getClientIp(request));
        if (!withinIpLimit) {
          return reply.code(429).send({
            error: "Too Many Requests",
            message: "You're checking too fast — please wait a moment and try again.",
            developer: "API developed and maintained by Spotix Technologies",
          });
        }
      } catch (err) {
        fastify.log.warn("[verify-payment] IP rate limit check failed (allowing request):", err);
      }

      const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
      if (!paystackSecretKey) {
        fastify.log.error("PAYSTACK_SECRET_KEY not configured");
        return reply.code(500).send({
          error: "Internal Server Error",
          message: "Server configuration error",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      // ── Load the reference ────────────────────────────────────────────────────
      const referenceDocRef = adminDb.collection("Reference").doc(ref);
      const referenceDoc = await referenceDocRef.get();

      if (!referenceDoc.exists) {
        return reply.code(404).send({
          error: "Not Found",
          message: "Payment reference not found",
          reference: ref,
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      const paymentData = referenceDoc.data();

      // Already fully settled — no need to hit Paystack again.
      const alreadySettled = isVoteRef
        ? paymentData.voteCredited === true || paymentData.status === "failed"
        : paymentData.ticketGenerated === true || paymentData.status === "failed";

      if (alreadySettled) {
        return reply.code(200).send({
          success: true,
          reference: ref,
          reconciled: false,
          status: paymentData.status || "pending",
          message: "Reference already settled — nothing to reconcile.",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      // Per-reference cooldown — protects Paystack from being hammered for
      // one reference even across different IPs/tabs/retries.
      let allowedToCheck = true;
      try {
        allowedToCheck = await claimRefCooldown(ref);
      } catch (err) {
        fastify.log.warn("[verify-payment] Ref cooldown check failed (allowing request):", err);
      }

      if (!allowedToCheck) {
        return reply.code(200).send({
          success: true,
          reference: ref,
          reconciled: false,
          status: paymentData.status || "pending",
          message: "A check for this reference was just run — please wait a few seconds.",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      // ── Ask Paystack directly ───────────────────────────────────────────────
      let paystackResult;
      try {
        paystackResult = await verifyWithPaystack(ref, paystackSecretKey);
      } catch (err) {
        fastify.log.error(`[verify-payment] Paystack verify call failed for ${ref}:`, err);
        return reply.code(200).send({
          success: true,
          reference: ref,
          reconciled: false,
          status: paymentData.status || "pending",
          message: "Could not reach Paystack right now — please try again shortly.",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      const txStatus = paystackResult?.data?.status; // "success" | "failed" | "abandoned" | ...

      // ── Transaction confirmed successful — update Reference + hand off ─────
      if (paystackResult?.status && txStatus === "success") {
        try {
          if (isVoteRef) {
            await processVotingCharge(fastify, "charge.success", paystackResult.data, ref);
          } else {
            const useAgentGenerator = paymentData?.isAgentSale && paymentData?.passMode === "pregenerated";

            await referenceDocRef.update({
              status: "successful",
              transactionType: "ticket_purchase",
              updatedAt: new Date().toISOString(),
              paymentCompletedAt: new Date().toISOString(),
              paystackEvent: "charge.success",
              reconciledVia: "verify-payment",
              amount: paystackResult.data?.amount ?? null,
              currency: paystackResult.data?.currency ?? null,
              customer: {
                email: paystackResult.data?.customer?.email ?? null,
                customerCode: paystackResult.data?.customer?.customer_code ?? null,
              },
            });

            const result = useAgentGenerator
              ? await generateAgentTickets(fastify, ref)
              : await generateTickets(fastify, ref);

            fastify.log.info(
              `[verify-payment] Reconciled ${ref}: ${
                result.alreadyGenerated ? "already generated" : `${result.totalTickets} ticket(s)`
              }`
            );
          }
        } catch (err) {
          // The reference status is already updated above (for tickets) or
          // inside processVotingCharge (for votes) — a hiccup in the
          // downstream generation step is logged and left for the next
          // webhook retry / manual re-check, never surfaced as a 500 to
          // the caller (the payment status update is what matters here).
          fastify.log.error(`[verify-payment] Reconciliation hand-off failed for ${ref} (non-blocking):`, err);
        }

        return reply.code(200).send({
          success: true,
          reference: ref,
          reconciled: true,
          status: "successful",
          message: "Payment confirmed with Paystack — reference updated.",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      // ── Transaction genuinely failed at Paystack ────────────────────────────
      if (paystackResult?.status && ["failed", "abandoned", "reversed"].includes(txStatus)) {
        await referenceDocRef.update({
          status: "failed",
          updatedAt: new Date().toISOString(),
          failureReason: paystackResult.data?.gateway_response ?? "Payment failed",
          paymentFailedAt: new Date().toISOString(),
          reconciledVia: "verify-payment",
        });

        return reply.code(200).send({
          success: true,
          reference: ref,
          reconciled: true,
          status: "failed",
          message: "Paystack reports this transaction did not succeed.",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      // ── Still pending/processing at Paystack — nothing to update ────────────
      return reply.code(200).send({
        success: true,
        reference: ref,
        reconciled: false,
        status: paymentData.status || "pending",
        message: "Payment is still pending — please check again shortly.",
        developer: "API developed and maintained by Spotix Technologies",
      });
    } catch (error) {
      fastify.log.error("Error verifying payment:", error);
      return reply.code(500).send({
        error: "Internal Server Error",
        message: "Failed to verify payment",
        details: error.message,
        developer: "API developed and maintained by Spotix Technologies",
      });
    }
  });

  /**
   * Health check for verify-payment endpoint
   */
  fastify.get("/verify-payment/health", async (request, reply) => {
    return reply.code(200).send({
      status: "healthy",
      service: "Payment Verification API",
      timestamp: new Date().toISOString(),
      developer: "API developed and maintained by Spotix Technologies",
    });
  });
}
