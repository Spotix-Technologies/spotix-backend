// v1/mcp.js
//
// Routes consumed by the spotix-mcp server (the Model Context Protocol
// server that lets AI chat models — ChatGPT, Claude, Gemini — search
// events, quote pricing, place ticket orders, and verify payment).
//
// This backend stays the single authoritative decision-maker for
// anything money- or inventory-related, same principle as every other
// checkout surface in Spotix: the MCP server is a thin client of these
// routes, never a second place pricing/availability/queue logic lives.
// See v1/lib/mcp/ for the actual logic — this file is just Fastify
// route wiring, matching the v1/queue.js / v1/lib/queue/ convention.

import { searchEvents } from "./lib/mcp/events.js";
import { getEventPricing, PricingError } from "./lib/mcp/pricing.js";
import { createOrder, getOrder, OrderError } from "./lib/mcp/orders.js";
import { checkRateLimit, getClientIp } from "./lib/mcp/rate-limit.js";

const DEV_TAG = "API developed and maintained by Spotix Technologies";

// Per-route rate limits — generous enough for normal chat-session usage,
// tight enough that one runaway agent loop can't hammer Firestore/Paystack.
const LIMITS = {
  events: { windowSeconds: 60, max: 30 },
  pricing: { windowSeconds: 60, max: 30 },
  createOrder: { windowSeconds: 60, max: 10 },
  getOrder: { windowSeconds: 60, max: 30 },
};

async function withRateLimit(request, reply, bucket, limitKey) {
  const limit = LIMITS[limitKey];
  const identifier = getClientIp(request);
  const { allowed } = await checkRateLimit(`mcp:${bucket}`, identifier, limit.windowSeconds, limit.max);
  if (!allowed) {
    reply.code(429).send({
      error: "Too Many Requests",
      message: "Rate limit exceeded for this endpoint — please slow down.",
      developer: DEV_TAG,
    });
    return false;
  }
  return true;
}

export default async function mcpRoutes(fastify, options) {
  // GET /mcp/events — search_events
  fastify.get("/events", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "events", "events"))) return;

    const { name, startDate, endDate, state, country, venue, eventType } = request.query;

    try {
      const results = await searchEvents(fastify, { name, startDate, endDate, state, country, venue, eventType });
      return reply.code(200).send({ success: true, count: results.length, events: results, developer: DEV_TAG });
    } catch (error) {
      fastify.log.error("[mcp/events] search failed:", error);
      return reply.code(500).send({ error: "Internal Server Error", message: "Failed to search events", developer: DEV_TAG });
    }
  });

  // GET /mcp/events/:eventId/pricing — get_pricing
  fastify.get("/events/:eventId/pricing", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "pricing", "pricing"))) return;

    const { eventId } = request.params;
    try {
      const pricing = await getEventPricing(eventId);
      return reply.code(200).send({ success: true, ...pricing, developer: DEV_TAG });
    } catch (error) {
      const statusCode = error instanceof PricingError ? error.statusCode : 500;
      fastify.log.error("[mcp/pricing] failed:", error?.message);
      return reply.code(statusCode).send({
        error: statusCode === 500 ? "Internal Server Error" : "Request Error",
        message: error?.message || "Failed to fetch pricing",
        developer: DEV_TAG,
      });
    }
  });

  // POST /mcp/orders — create_ticket_order
  fastify.post("/orders", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "orders", "createOrder"))) return;

    try {
      const order = await createOrder(fastify, request.body || {});
      return reply.code(201).send({ success: true, ...order, developer: DEV_TAG });
    } catch (error) {
      const statusCode = error instanceof OrderError ? error.statusCode : 500;
      fastify.log.error("[mcp/orders:create] failed:", error?.message);
      return reply.code(statusCode).send({
        error: statusCode === 500 ? "Internal Server Error" : "Request Error",
        message: error?.message || "Failed to create order",
        queueRequired: error?.queueRequired ?? false,
        eventId: error?.eventId,
        developer: DEV_TAG,
      });
    }
  });

  // GET /mcp/orders/:reference — backs verify_payment (called AFTER
  // GET /v1/verify-payment?ref= has already reconciled the payment).
  fastify.get("/orders/:reference", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "orders-get", "getOrder"))) return;

    const { reference } = request.params;
    try {
      const order = await getOrder(reference);
      return reply.code(200).send({ success: true, ...order, developer: DEV_TAG });
    } catch (error) {
      const statusCode = error instanceof OrderError ? error.statusCode : 500;
      fastify.log.error("[mcp/orders:get] failed:", error?.message);
      return reply.code(statusCode).send({
        error: statusCode === 500 ? "Internal Server Error" : "Request Error",
        message: error?.message || "Failed to fetch order",
        developer: DEV_TAG,
      });
    }
  });

  fastify.get("/health", async (request, reply) => {
    return reply.code(200).send({ status: "healthy", service: "Spotix MCP Backend API", timestamp: new Date().toISOString(), developer: DEV_TAG });
  });
}
