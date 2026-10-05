/* 
The backend is developed and maintained by Drexx Codes and the Spotix Team 
2025 - till date
*/

// Must be the very first import. ESM evaluates imports top-to-bottom
// before any of this file's own code runs — so if dotenv.config() were
// called later (as a plain statement, like it used to be, several lines
// below every route import), every route module imported above it would
// already have run its own top-level code — including
// v1/utils/redis-client.js's `new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, ... })`
// — with process.env still empty. That's the exact "Redis client was
// initialized without url or token" symptom: the .env values are fine,
// they just weren't loaded yet when that module evaluated.
import "dotenv/config";

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "url";
import path, { dirname } from "path";
import fs from "fs";

// Global rate limiting — was previously only opt-in per-route (see
// v1/middleware/rate-limit.js), never actually applied anywhere, so
// nothing was really being limited backend-wide.
import { checkRateLimit, getClientIp } from "./v1/middleware/rate-limit.js";

// Routes
import paymentRoute from "./v1/routes/payment.js";
import verifyRoute from "./v1/routes/verify.js";
import sendMailRoutes from "./v1/routes/mail.js";
import notifyRoutes from "./v1/routes/notify.js";
import webhookRoute from "./v1/routes/webhook.js";
import verifyPaymentRoute from "./v1/routes/verify-payment.js";
import ticketRoute from "./v1/routes/ticket.js";
import generateAgentTickets from "./v1/routes/ticket-agent.js";
import freeTicketRoute from "./v1/routes/ticket2.js";
import payoutProcessRoute from "./v1/routes/payout-process.js";
import payoutStreamRoute from "./v1/routes/payout-stream.js";
import cronForecastRoute from "./v1/routes/cron/forecast.js";
import cronProcessCampaignsRoute from "./v1/routes/cron/process-campaigns.js";
import resendWebhookRoute from "./v1/routes/webhooks/resend.js";
import sesWebhookRoute from "./v1/routes/webhooks/ses.js";
import unsubscribeRoute from "./v1/routes/unsubscribe.js";
import dicebearRoute  from "./v1/routes/dicebear.js";
import qrCodeRoute from "./v1/routes/qrcode.js";
import customerRoute from "./v1/routes/customer.js";
import adminTransferRoute from "./v1/routes/admin-transfer.js";
import queueRoute from "./v1/routes/queue.js";
import postMortemRoute from "./v1/routes/post-mortem.js";
import mcpRoutes from "./v1/routes/mcp.js";
import mcpOAuthRoutes from "./v1/routes/mcp-oauth.js";
import mcpOAuthMetadataRoutes from "./v1/routes/mcp-oauth-metadata.js";
import mcpBookerRoutes from "./v1/routes/mcp-booker.js";
import campaignsRoute from "./v1/routes/campaigns.js";
import adminCampaignsRoute from "./v1/routes/admin-campaigns.js";
import smsCampaignsRoute from "./v1/routes/sms-campaigns.js";
import adminSmsRoute from "./v1/routes/admin-sms.js";
// v1/routes/cron/payout.js and v1/routes/gemini-enhance.js exist but were
// never registered below in the original codebase either — not imported
// here on purpose, see the notes in their controllers if you want them live.


// __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Init Fastify
const fastify = Fastify({ logger: true });

/* -------------------- CORS CONFIG -------------------- */

const allowedOrigins = new Set([
  "https://spotix.com.ng",
  "https://api.spotix.com.ng",
  "https://www.spotix.com.ng",
  "https://booker.spotix.com.ng",
  "https://www.booker.spotix.com.ng",
  "https://spotix-backend.onrender.com",
  "https://console.spotix.com.ng",
  "https://events.spotix.com.ng",
  "https://www.events.spotix.com.ng",
  "https://www.bot.spotix.com.ng",
  "https://bot.spotix.com.ng",
  "https://mcp.spotix.com.ng",
  "https://www.mcp.spotix.com.ng",

  
]);

await fastify.register(fastifyCors, {
  origin: (origin, cb) => {
    // Allow internal calls, health checks, webhooks, curl
    if (!origin) return cb(null, true);

    // Allow localhost for development
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }

    // Allow known production domains
    if (allowedOrigins.has(origin)) {
      return cb(null, true);
    }

    // Block everything else
    cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

/* ---------------------------------------------------- */

/* -------------------- GLOBAL RATE LIMIT -------------------- */
// Applies to every route on this backend, by client IP. Fixed-window
// counter on the same shared Upstash Redis instance the per-route MCP
// limiter already uses (v1/middleware/rate-limit.js) — fails OPEN on a
// Redis hiccup, same as everywhere else that calls checkRateLimit, so a
// Redis outage degrades to "no rate limiting" rather than "no API".
//
// Defaults are generous on purpose (this sits in front of everything,
// including polling dashboards) — tune via env if a specific window/
// limit is needed. Health checks and CORS preflight are excluded.
const GLOBAL_RATE_LIMIT_WINDOW_SECONDS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS) || 60;
const GLOBAL_RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 300;

fastify.addHook("onRequest", async (request, reply) => {
  if (request.method === "OPTIONS") return;
  if (request.url === "/favicon.ico" || request.url === "/v1/test") return;

  const ip = getClientIp(request);
  const { allowed, remaining } = await checkRateLimit(
    "global",
    ip,
    GLOBAL_RATE_LIMIT_WINDOW_SECONDS,
    GLOBAL_RATE_LIMIT_MAX_REQUESTS
  );

  reply.header("X-RateLimit-Limit", GLOBAL_RATE_LIMIT_MAX_REQUESTS);
  reply.header("X-RateLimit-Remaining", remaining);

  if (!allowed) {
    reply.header("Retry-After", GLOBAL_RATE_LIMIT_WINDOW_SECONDS);
    return reply.code(429).send({
      success: false,
      error: "rate_limited",
      message: "Too many requests — please try again shortly.",
    });
  }
});
/* -------------------------------------------------------------- */

// Prevent favicon noise
fastify.get("/favicon.ico", (_, reply) => {
  reply.code(204).send();
});

// Test route
fastify.get("/v1/test", async () => {
  return { message: "Server is working!" };
});

// API routes
fastify.register(paymentRoute, { prefix: "/v1" });
fastify.register(verifyRoute, { prefix: "/v1" });
fastify.register(sendMailRoutes, { prefix: "/v1/mail" });
fastify.register(notifyRoutes, { prefix: "/v1/notify" });
fastify.register(webhookRoute, { prefix: "/v1" });
fastify.register(ticketRoute, { prefix: "/v1" });
fastify.register(generateAgentTickets, { prefix: "/v1" });
fastify.register(verifyPaymentRoute, { prefix: "/v1" });
fastify.register(freeTicketRoute, { prefix: "/v1" });
fastify.register(payoutProcessRoute, { prefix: "/v1" });
fastify.register(payoutStreamRoute, { prefix: "/v1" });
fastify.register(cronForecastRoute, { prefix: "/v1" });
fastify.register(cronProcessCampaignsRoute, { prefix: "/v1" });
fastify.register(resendWebhookRoute, { prefix: "/v1" });
fastify.register(sesWebhookRoute, { prefix: "/v1" });
fastify.register(unsubscribeRoute, { prefix: "/v1" });
fastify.register(dicebearRoute, { prefix: "/v1" });
fastify.register(qrCodeRoute, { prefix: "/v1" });
fastify.register(customerRoute, { prefix: "/v1" });
fastify.register(adminTransferRoute, { prefix: "/v1" });
fastify.register(queueRoute, { prefix: "/v1" });
fastify.register(postMortemRoute, { prefix: "/v1" });
fastify.register(campaignsRoute, { prefix: "/v1" });
fastify.register(adminCampaignsRoute, { prefix: "/v1" });
fastify.register(smsCampaignsRoute, { prefix: "/v1" });
fastify.register(adminSmsRoute, { prefix: "/v1" });
fastify.register(mcpRoutes, { prefix: "/v1/mcp" });
// v1.0.1b (beta): OAuth authorization server for the MCP's new
// authenticated booker-management tools, plus the routes those tools
// actually call. Kept as separate plugins/prefixes from mcpRoutes above
// so the original 4 anonymous tools' route file never has to know these
// exist. See v1/mcp-oauth.js and v1/mcp-booker.js for details.
fastify.register(mcpOAuthRoutes, { prefix: "/v1/mcp/oauth" });
fastify.register(mcpOAuthMetadataRoutes); // no prefix — .well-known/* is root-relative by spec
fastify.register(mcpBookerRoutes, { prefix: "/v1/mcp/booker" });
// Serve frontend if dist exists
const distPath = path.join(__dirname, "dist");

if (fs.existsSync(distPath)) {
  await fastify.register(fastifyStatic, {
    root: distPath,
    prefix: "/",
    decorateReply: false,
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/v1/")) {
      return reply.code(404).send({ error: "API route not found" });
    }
    return reply.sendFile("index.html");
  });
}

// Start server
const start = async () => {
  try {
    const PORT = process.env.PORT || 2000;
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`🚀 Server running on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
