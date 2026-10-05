// v1/routes/payment.js
//
// Fastify route wiring only — see v1/controllers/payment.controller.js
// for the actual Paystack initialize/verify/health-check logic.

import {
  initializePaymentSchema,
  verifyPaymentSchema,
  initializePayment,
  verifyPayment,
  pingPayment,
  healthCheckPayment,
} from "../controllers/payment.controller.js";

export default async function paymentRoute(fastify, options) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new Error("PAYSTACK_SECRET_KEY environment variable is required");
  }

  fastify.post("/payment", { schema: initializePaymentSchema, handler: initializePayment });
  fastify.get("/payment/verify", { schema: verifyPaymentSchema, handler: verifyPayment });
  fastify.get("/payment/ping", pingPayment);
  fastify.get("/payment/health", healthCheckPayment);
}
