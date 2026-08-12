// v1/customer.js
//
// Paystack Customer Upsert Route
//
// POST /customer/upsert
//
// Registers a Paystack Customer record with first_name/last_name/phone
// BEFORE the buyer's checkout modal opens — but ONLY if that email has no
// existing Customer record on the integration yet.
//

import fetch from "node-fetch";

async function findExistingCustomer(email, secretKey) {
  const response = await fetch(`https://api.paystack.co/customer/${encodeURIComponent(email)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  if (response.status === 404) return null;

  const data = await response.json();
  if (!response.ok || data?.status !== true || !data?.data) return null;

  return data.data;
}

function buildMissingFieldsPatch(existing, { firstName, lastName, phone }) {
  const patch = {};

  if (firstName && !existing.first_name) patch.first_name = firstName;
  if (lastName && !existing.last_name) patch.last_name = lastName;
  if (phone && !existing.phone) patch.phone = phone;

  return patch;
}

async function patchCustomer(customerCode, patch, secretKey) {
  const response = await fetch(`https://api.paystack.co/customer/${encodeURIComponent(customerCode)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });

  const data = await response.json();
  if (!response.ok || data?.status !== true) {
    throw new Error(data?.message || `Paystack PUT /customer/${customerCode} failed`);
  }

  return data.data;
}

export default async function customerRoute(fastify, options) {
  fastify.post("/customer/upsert", async (request, reply) => {
    try {
      const { email, firstName, lastName, phone } = request.body || {};

      if (!email || typeof email !== "string") {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Missing required parameter: email",
          developer: "API developed and maintained by Spotix Technologies",
        });
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

      // Only create if this email has no Customer record yet 
      let existing;
      try {
        existing = await findExistingCustomer(email, paystackSecretKey);
      } catch (err) {
        fastify.log.warn(`[customer] Lookup failed for ${email}, skipping upsert (non-blocking):`, err);
        return reply.code(200).send({ success: false, message: "Customer lookup failed" });
      }

      if (existing) {
        const patch = buildMissingFieldsPatch(existing, { firstName, lastName, phone });

        if (Object.keys(patch).length === 0) {
          // Nothing missing to backfill — leave the record as-is.
          return reply.code(200).send({
            success: true,
            skipped: true,
            patched: false,
            customerCode: existing.customer_code ?? null,
          });
        }

        try {
          const updated = await patchCustomer(existing.customer_code, patch, paystackSecretKey);
          // fastify.log.info(`[customer] Backfilled ${Object.keys(patch).join(", ")} for ${email} (${existing.customer_code})`);
          return reply.code(200).send({
            success: true,
            skipped: false,
            patched: true,
            customerCode: updated?.customer_code ?? existing.customer_code ?? null,
          });
        } catch (err) {
          // Non-blocking by design — the existing record is still valid,
          // it just didn't get the backfill this time around.
          fastify.log.warn(`[customer] Backfill patch failed for ${email} (${existing.customer_code}):`, err);
          return reply.code(200).send({
            success: true,
            skipped: true,
            patched: false,
            customerCode: existing.customer_code ?? null,
            message: "Customer exists but backfill patch failed",
          });
        }
      }

      const payload = { email };
      if (firstName) payload.first_name = firstName;
      if (lastName) payload.last_name = lastName;
      if (phone) payload.phone = phone;

      const response = await fetch("https://api.paystack.co/customer", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok || data?.status !== true) {
        // Most likely a race — the customer got created between our GET
        // and this POST (e.g. two tabs checking out at once). Not an
        // error worth surfacing; either way a customer record now exists.
        fastify.log.warn(`[customer] Paystack customer create failed for ${email}: ${data?.message}`);
        return reply.code(200).send({ success: false, message: data?.message || "Could not register customer" });
      }

      // fastify.log.info(`[customer] Created Paystack customer ${data?.data?.customer_code} for ${email}`);

      return reply.code(200).send({
        success: true,
        skipped: false,
        customerCode: data?.data?.customer_code ?? null,
      });
    } catch (err) {
      fastify.log.error("[customer] Error upserting Paystack customer:", err);
      // Non-blocking by design.
      return reply.code(200).send({ success: false, message: "Failed to register customer" });
    }
  });

  fastify.get("/customer/health", async (request, reply) => {
    return reply.code(200).send({
      status: "healthy",
      service: "Customer Upsert API",
      timestamp: new Date().toISOString(),
      developer: "API developed and maintained by Spotix Technologies",
    });
  });
}
