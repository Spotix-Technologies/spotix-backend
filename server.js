/* 
The backend is developed and maintained by Drexx Codes and the Spotix Team 
2025 - till date
*/

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "url";
import path, { dirname } from "path";
import fs from "fs";
import dotenv from "dotenv";

// Routes
import paymentRoute from "./v1/payment.js";
import verifyRoute from "./v1/verify.js";
import sendMailRoutes from "./v1/mail.js";
import notifyRoutes from "./v1/notify.js";
import webhookRoute from "./v1/webhook.js";
import verifyPaymentRoute from "./v1/verify-payment.js";
import ticketRoute from "./v1/ticket.js";
import freeTicketRoute from "./v1/ticket2.js";
import cronPayoutRoute from "./v1/cron/payout.js";
import { processTransferEvents } from "./v1/payout.js";
import cronForecastRoute from "./v1/cron/forecast.js";


// Load env
dotenv.config();

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
fastify.register(verifyPaymentRoute, { prefix: "/v1" });
fastify.register(freeTicketRoute, { prefix: "/v1" });
fastify.register(cronPayoutRoute, { prefix: "/v1" });
fastify.register(processTransferEvents, { prefix: "/v1" });
fastify.register(cronForecastRoute, { prefix: "/v1" });

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
