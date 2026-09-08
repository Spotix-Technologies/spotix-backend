// v1/queue.js
//
// Virtual Queue API
//
// Opt-in per event (events/{eventId}.virtualQueueEnabled in Firestore).
// When enabled, buyers wait in a Redis-backed virtual line instead of
// hitting /event/[eventId]/payment directly, and are admitted to
// checkout in batches so ticket inventory writes and Paystack init calls
// stay bounded during high-traffic sales.
//
// No login required — identity is a signed, opaque queue token (HMAC'd,
// carries eventId + a random jti), used as the member string in the Redis
// sorted sets below. See README notes inline for the data model.
//
// Data model (Upstash Redis, shared instance — see ./redis.js):
//   vqueue:queue:{eventId}   sorted set — everyone waiting.
//                            score = join time bucketed into JOIN_WINDOW_SECONDS
//                            windows, jittered randomly *within* the window.
//                            This keeps rough arrival order over the life of
//                            the queue, but kills the millisecond-precision
//                            advantage a bot gets by hitting "join" at the
//                            exact instant the queue opens.
//   vqueue:active:{eventId}  sorted set — currently admitted, holding a
//                            checkout slot. score = unix seconds the slot
//                            expires (now + queueSessionTTL).
//   vqueue:log:{eventId}     sorted set — one entry per admission event,
//                            score = admission time. Used to measure a live
//                            admissions-per-second rate for ETA estimates;
//                            trimmed to ADMISSION_LOG_RETENTION seconds.
//   vqueue:active-events     plain set — eventIds with a non-empty queue or
//                            active set, so the sweep loop knows which
//                            events to process without scanning everything.
//   vqueue:config:{eventId}  cached copy of the event's queue config
//                            (virtualQueueEnabled/queueBatchSize/
//                            queueSessionTTL), TTL'd so the sweep loop
//                            (every 3s) doesn't hit Firestore every tick —
//                            exactly the read volume this feature exists to
//                            protect against.
//
// Admission, config caching, token signing, and ETA estimation are all
// broken out into ./lib/queue/ (see that folder for the data model
// details on each piece) — this file is just the Fastify route wiring
// and the background sweep interval.

import crypto from "crypto";
import { redis } from "./redis.js";
import { JOIN_WINDOW_SECONDS, SWEEP_INTERVAL_MS, queueKey, activeKey, ACTIVE_EVENTS_KEY } from "./lib/queue/constants.js";
import { signToken, verifyToken } from "./lib/queue/token.js";
import { getQueueConfig } from "./lib/queue/config.js";
import { runSweep, sweepAllActiveEvents } from "./lib/queue/sweep.js";
import { estimateWait } from "./lib/queue/eta.js";

const DEV_TAG = "API developed and maintained by Spotix Technologies";

// ── Fastify routes ───────────────────────────────────────────────────────
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

  // GET /queue/config?eventId=
  fastify.get("/queue/config", async (request, reply) => {
    const { eventId } = request.query;
    if (!eventId) {
      return reply.code(400).send({
        error: "Bad Request",
        message: "Missing required parameter: eventId",
        developer: DEV_TAG,
      });
    }
    const config = await getQueueConfig(eventId);
    return reply.code(200).send({
      success: true,
      enabled: config.enabled,
      batchSize: config.batchSize,
      developer: DEV_TAG,
    });
  });

  // POST /queue/join  { eventId }
  fastify.post("/queue/join", async (request, reply) => {
    try {
      const { eventId } = request.body || {};
      if (!eventId) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Missing required parameter: eventId",
          developer: DEV_TAG,
        });
      }

      const config = await getQueueConfig(eventId);
      if (!config.enabled) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Virtual queue is not enabled for this event",
          developer: DEV_TAG,
        });
      }

      const token = signToken({ eventId, jti: crypto.randomUUID(), iat: Date.now() });

      const nowSeconds = Date.now() / 1000;
      const windowed = Math.floor(nowSeconds / JOIN_WINDOW_SECONDS) * JOIN_WINDOW_SECONDS;
      const score = windowed + Math.random() * JOIN_WINDOW_SECONDS;

      await redis.zadd(queueKey(eventId), { score, member: token });
      await redis.sadd(ACTIVE_EVENTS_KEY, eventId);

      const position = await redis.zrank(queueKey(eventId), token);

      return reply.code(200).send({
        success: true,
        queueToken: token,
        position: (position ?? 0) + 1,
        batchSize: config.batchSize,
        developer: DEV_TAG,
      });
    } catch (error) {
      fastify.log.error(`[queue] join error: ${error?.message}`);
      return reply.code(500).send({
        error: "Internal Server Error",
        message: "Failed to join queue",
        developer: DEV_TAG,
      });
    }
  });

  // GET /queue/status?eventId=&token=
  fastify.get("/queue/status", async (request, reply) => {
    try {
      const { eventId, token } = request.query;
      if (!eventId || !token) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Missing required parameter: eventId or token",
          developer: DEV_TAG,
        });
      }

      const payload = verifyToken(token);
      if (!payload || payload.eventId !== eventId) {
        return reply.code(200).send({ success: true, status: "expired", developer: DEV_TAG });
      }

      const config = await getQueueConfig(eventId);

      const expiresAt = await redis.zscore(activeKey(eventId), token);
      const now = Math.floor(Date.now() / 1000);
      if (expiresAt !== null && expiresAt !== undefined && Number(expiresAt) > now) {
        return reply.code(200).send({
          success: true,
          status: "admitted",
          expiresAt: Number(expiresAt),
          developer: DEV_TAG,
        });
      }

      const rank = await redis.zrank(queueKey(eventId), token);
      if (rank === null || rank === undefined) {
        return reply.code(200).send({ success: true, status: "expired", developer: DEV_TAG });
      }

      const [totalWaiting, eta] = await Promise.all([
        redis.zcard(queueKey(eventId)),
        estimateWait(eventId, rank, config.batchSize),
      ]);

      return reply.code(200).send({
        success: true,
        status: "waiting",
        position: rank + 1,
        totalWaiting,
        etaSeconds: eta.etaSeconds,
        etaLabel: eta.etaLabel,
        developer: DEV_TAG,
      });
    } catch (error) {
      fastify.log.error(`[queue] status error: ${error?.message}`);
      return reply.code(500).send({
        error: "Internal Server Error",
        message: "Failed to check queue status",
        developer: DEV_TAG,
      });
    }
  });

  // POST /queue/complete  { eventId, token }
  // Releases a held checkout slot the instant checkout finishes, instead of
  // waiting for the session TTL to expire, and immediately tries to admit
  // the next person rather than waiting for the next sweep tick. Always
  // 200 — this must never block a buyer's payment success flow.
  fastify.post("/queue/complete", async (request, reply) => {
    try {
      const { eventId, token } = request.body || {};
      if (!eventId || !token) {
        return reply.code(200).send({ success: false, developer: DEV_TAG });
      }
      await redis.zrem(activeKey(eventId), token);
      const config = await getQueueConfig(eventId);
      runSweep(fastify, eventId, config.batchSize, config.sessionTTL).catch(() => {});
      return reply.code(200).send({ success: true, developer: DEV_TAG });
    } catch (error) {
      fastify.log.warn(`[queue] complete error (non-blocking): ${error?.message}`);
      return reply.code(200).send({ success: false, developer: DEV_TAG });
    }
  });

  // POST /queue/leave  { eventId, token }
  // Best-effort — a buyer closing the tab while still waiting frees their
  // spot instead of holding it uselessly. Always 200.
  fastify.post("/queue/leave", async (request, reply) => {
    try {
      const { eventId, token } = request.body || {};
      if (!eventId || !token) {
        return reply.code(200).send({ success: false, developer: DEV_TAG });
      }
      await redis.zrem(queueKey(eventId), token);
      return reply.code(200).send({ success: true, developer: DEV_TAG });
    } catch (error) {
      fastify.log.warn(`[queue] leave error (non-blocking): ${error?.message}`);
      return reply.code(200).send({ success: false, developer: DEV_TAG });
    }
  });

  fastify.get("/queue/health", async (request, reply) => {
    return reply.code(200).send({
      status: "healthy",
      service: "Virtual Queue API",
      timestamp: new Date().toISOString(),
      developer: DEV_TAG,
    });
  });
}
