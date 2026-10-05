// v1/mcp-booker.js
//
// Routes consumed by spotix-mcp's v1.0.1b (beta) tools — the
// authentication-required half of the MCP surface, for bookers managing
// their OWN events through an AI chat client. Every route here requires
// a valid Bearer access token (see v1/lib/mcp-oauth/auth.js's
// requireMcpAuth) minted by the OAuth flow in v1/mcp-oauth.js.
//
// Same division of responsibility as v1/mcp.js: this file is just Fastify
// route wiring + rate limiting; all actual logic (ownership checks,
// discount/slug validation, stats aggregation) lives in
// v1/lib/mcp/booker-events.js.

import { requireMcpAuth } from "../lib/mcp-oauth/auth.js";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit.js";
import {
  BookerEventsError,
  listMyEvents,
  getMyEventStats,
  listDiscounts,
  createDiscount,
  deactivateDiscount,
  listReferrals,
  createReferral,
  shareEvent,
} from "../lib/mcp/booker-events.js";

const DEV_TAG = "API developed and maintained by Spotix Technologies";

// Tighter than the anonymous v1/mcp.js limits — these calls are gated to
// one booker's own data (not shared public inventory), and per-booker +
// per-IP double-keying means a compromised token still can't be used to
// hammer Firestore from a single caller.
const LIMITS = {
  read: { windowSeconds: 60, max: 40 },
  write: { windowSeconds: 60, max: 15 },
};

async function withRateLimit(request, reply, bucket, kind) {
  const limit = LIMITS[kind];
  const identifier = `${request.mcpAuth.uid}:${getClientIp(request)}`;
  const { allowed } = await checkRateLimit(`mcp-booker:${bucket}`, identifier, limit.windowSeconds, limit.max);
  if (!allowed) {
    reply.code(429).send({ error: "Too Many Requests", message: "Rate limit exceeded — please slow down.", developer: DEV_TAG });
    return false;
  }
  return true;
}

function handleError(reply, fastify, label, error) {
  const statusCode = error instanceof BookerEventsError ? error.statusCode : 500;
  if (statusCode === 500) fastify.log.error({ err: error }, `[mcp-booker] ${label} failed`);
  return reply.code(statusCode).send({
    error: statusCode === 500 ? "Internal Server Error" : "Request Error",
    message: error?.message || "Something went wrong",
    developer: DEV_TAG,
  });
}

export default async function mcpBookerRoutes(fastify, options) {
  // Every route below requires a valid Bearer token EXCEPT /health, which
  // stays open so uptime checks don't need a token. Fastify skips the
  // route handler entirely once a preHandler hook sends a reply, so
  // there's no need for handlers to re-check reply.sent themselves.
  fastify.addHook("preHandler", async (request, reply) => {
    // request.url includes this plugin's prefix + any query string —
    // checking the path segment directly avoids relying on
    // request.routerPath/routeOptions, whose shape has moved between
    // Fastify major versions.
    if (request.url.split("?")[0].endsWith("/health")) return;
    await requireMcpAuth(request, reply);
  });

  // GET /my-events               — list every event the caller owns
  // GET /my-events?eventId=...   — verify ownership of / fetch one event
  fastify.get("/my-events", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "my-events", "read"))) return;
    try {
      const result = await listMyEvents(request.mcpAuth.uid, request.query?.eventId);
      return reply.code(200).send({ success: true, ...result, developer: DEV_TAG });
    } catch (err) {
      return handleError(reply, fastify, "my-events", err);
    }
  });

  // GET /my-events/:eventId/stats
  fastify.get("/my-events/:eventId/stats", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "stats", "read"))) return;
    try {
      const stats = await getMyEventStats(request.mcpAuth.uid, request.params.eventId);
      return reply.code(200).send({ success: true, stats, developer: DEV_TAG });
    } catch (err) {
      return handleError(reply, fastify, "stats", err);
    }
  });

  // GET /my-events/:eventId/discounts            — list all
  // GET /my-events/:eventId/discounts?code=XXX    — one, by code
  fastify.get("/my-events/:eventId/discounts", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "discounts-list", "read"))) return;
    try {
      const result = await listDiscounts(request.mcpAuth.uid, request.params.eventId, request.query?.code);
      return reply.code(200).send({ success: true, ...result, developer: DEV_TAG });
    } catch (err) {
      return handleError(reply, fastify, "discounts-list", err);
    }
  });

  // POST /my-events/:eventId/discounts
  fastify.post("/my-events/:eventId/discounts", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "discounts-create", "write"))) return;
    try {
      const result = await createDiscount(request.mcpAuth.uid, request.params.eventId, request.body || {});
      return reply.code(201).send({ success: true, ...result, developer: DEV_TAG });
    } catch (err) {
      return handleError(reply, fastify, "discounts-create", err);
    }
  });

  // PATCH /my-events/:eventId/discounts/deactivate  Body: { discountId? , code? }
  fastify.patch("/my-events/:eventId/discounts/deactivate", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "discounts-deactivate", "write"))) return;
    try {
      const result = await deactivateDiscount(request.mcpAuth.uid, request.params.eventId, request.body || {});
      return reply.code(200).send({ success: true, ...result, developer: DEV_TAG });
    } catch (err) {
      return handleError(reply, fastify, "discounts-deactivate", err);
    }
  });

  // GET /my-events/:eventId/referrals            — list all
  // GET /my-events/:eventId/referrals?code=XXX    — one, with usage history
  fastify.get("/my-events/:eventId/referrals", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "referrals-list", "read"))) return;
    try {
      const result = await listReferrals(request.mcpAuth.uid, request.params.eventId, request.query?.code);
      return reply.code(200).send({ success: true, ...result, developer: DEV_TAG });
    } catch (err) {
      return handleError(reply, fastify, "referrals-list", err);
    }
  });

  // POST /my-events/:eventId/referrals   Body: { code }
  fastify.post("/my-events/:eventId/referrals", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "referrals-create", "write"))) return;
    try {
      const result = await createReferral(request.mcpAuth.uid, request.params.eventId, request.body?.code);
      return reply.code(201).send({ success: true, ...result, developer: DEV_TAG });
    } catch (err) {
      return handleError(reply, fastify, "referrals-create", err);
    }
  });

  // GET  /my-events/:eventId/share                      — current link (or needsSlug: true)
  // POST /my-events/:eventId/share   Body: { desiredSlug } — create the link
  fastify.get("/my-events/:eventId/share", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "share", "read"))) return;
    try {
      const result = await shareEvent(request.mcpAuth.uid, request.params.eventId, undefined);
      return reply.code(200).send({ success: true, ...result, developer: DEV_TAG });
    } catch (err) {
      return handleError(reply, fastify, "share", err);
    }
  });

  fastify.post("/my-events/:eventId/share", async (request, reply) => {
    if (!(await withRateLimit(request, reply, "share-create", "write"))) return;
    try {
      const result = await shareEvent(request.mcpAuth.uid, request.params.eventId, request.body?.desiredSlug);
      return reply.code(200).send({ success: true, ...result, developer: DEV_TAG });
    } catch (err) {
      return handleError(reply, fastify, "share-create", err);
    }
  });

  fastify.get("/health", async (request, reply) => {
    return reply.code(200).send({ status: "healthy", service: "Spotix MCP Booker API", timestamp: new Date().toISOString(), developer: DEV_TAG });
  });
}
