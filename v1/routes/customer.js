// v1/routes/customer.js
//
// Paystack Customer Upsert Route — POST /customer/upsert
// Fastify route wiring only — see v1/controllers/customer.controller.js
// for the actual lookup/create/patch logic.

import { upsertCustomer, customerHealth } from "../controllers/customer.controller.js";

export default async function customerRoute(fastify, options) {
  fastify.post("/customer/upsert", upsertCustomer);
  fastify.get("/customer/health", customerHealth);
}
