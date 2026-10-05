// v1/routes/queue.js
//
// Virtual Queue API — Fastify route wiring + the background admission
// sweep interval only. See v1/controllers/queue.controller.js for the
// route handlers and v1/lib/queue/ for the admission/config/token/ETA
// logic and full data-model notes.

import { SWEEP_INTERVAL_MS } from "../lib/queue/constants.js";
import { sweepAllActiveEvents } from "../lib/queue/sweep.js";
import {
  getQueueConfigHandler,
  joinQueue,
  getQueueStatus,
  completeQueue,
  leaveQueue,
  queueHealth,
} from "../controllers/queue.controller.js";

export default async function queueRoute(fastify, options) {
  // Background admission sweep — runs for the lifetime of this process.
  // Safe because server.js runs a persistent fastify.listen() process
  // (not a serverless function), same as the rest of this backend.
  const sweepInterval = setInterval(() => {
    sweepAllActiveEvents(fastify).catch((err) => {
      fastify.log.error(`[queue] sweepAllActiveEvents error: ${err?.message}`);
    });
  }, SWEEP_INTERVAL_MS);
  sweepInterval.unref?.();

  fastify.addHook("onClose", (instance, done) => {
    clearInterval(sweepInterval);
    done();
  });

  fastify.get("/queue/config", getQueueConfigHandler);
  fastify.post("/queue/join", joinQueue);
  fastify.get("/queue/status", getQueueStatus);
  fastify.post("/queue/complete", completeQueue);
  fastify.post("/queue/leave", leaveQueue);
  fastify.get("/queue/health", queueHealth);
}
