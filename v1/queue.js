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
// Admission is a single atomic Lua script (SWEEP_SCRIPT below): evict
// expired active sessions, compute freed capacity, ZPOPMIN that many off
// the queue (lowest score = next up), and promote them into the active
// set. Runs on a fixed interval for every tracked event, AND immediately
// on /queue/complete so a freed slot doesn't sit idle until the next tick.

import crypto from "crypto";
import { adminDb } from "./firebase-admin.js";
import { redis } from "./redis.js";

const DEV_TAG = "API developed and maintained by Spotix Technologies";

// ── Tunables ─────────────────────────────────────────────────────────────
const DEFAULT_BATCH_SIZE = 50;             // max concurrent checkout slots
const DEFAULT_SESSION_TTL = 480;           // seconds a checkout slot is held (8 min)
const JOIN_WINDOW_SECONDS = 10;            // randomize within this window to blunt bot precision
const SWEEP_INTERVAL_MS = 3000;            // admission worker cadence
const ADMISSION_LOG_WINDOW = 60;           // seconds of history used to measure live throughput
const ADMISSION_LOG_RETENTION = 300;       // seconds admission-log entries are kept
const COLD_START_ASSUMED_COMPLETION_SECS = 90; // fallback throughput assumption before real data exists
const CONFIG_CACHE_TTL = 20;               // seconds — how stale an enable/disable toggle can be

// ── Redis keys ───────────────────────────────────────────────────────────
const queueKey = (eventId) => `vqueue:queue:${eventId}`;
const activeKey = (eventId) => `vqueue:active:${eventId}`;
const logKey = (eventId) => `vqueue:log:${eventId}`;
const configCacheKey = (eventId) => `vqueue:config:${eventId}`;
const ACTIVE_EVENTS_KEY = "vqueue:active-events";

// ── Token signing (anonymous identity) ──────────────────────────────────
function getSecret() {
  const secret = process.env.QUEUE_TOKEN_SECRET;
  if (!secret) throw new Error("QUEUE_TOKEN_SECRET environment variable is required");
  return secret;
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  let expectedSig;
  try {
    expectedSig = crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
  } catch {
    return null;
  }

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// ── Event queue config (cached) ─────────────────────────────────────────
async function getQueueConfig(eventId) {
  try {
    const cached = await redis.get(configCacheKey(eventId));
    if (cached) return cached;
  } catch {
    // fall through to Firestore read
  }

  let config;
  try {
    const doc = await adminDb.collection("events").doc(eventId).get();
    if (!doc.exists) {
      config = { enabled: false, batchSize: DEFAULT_BATCH_SIZE, sessionTTL: DEFAULT_SESSION_TTL };
    } else {
      const d = doc.data();
      config = {
        enabled: d.virtualQueueEnabled === true,
        batchSize: Number(d.queueBatchSize) > 0 ? Number(d.queueBatchSize) : DEFAULT_BATCH_SIZE,
        sessionTTL: Number(d.queueSessionTTL) > 0 ? Number(d.queueSessionTTL) : DEFAULT_SESSION_TTL,
      };
    }
  } catch {
    config = { enabled: false, batchSize: DEFAULT_BATCH_SIZE, sessionTTL: DEFAULT_SESSION_TTL };
  }

  try {
    await redis.set(configCacheKey(eventId), config, { ex: CONFIG_CACHE_TTL });
  } catch {
    // best-effort cache write — a miss just means the next call re-reads Firestore
  }

  return config;
}

// ── Atomic admission sweep ──────────────────────────────────────────────
// KEYS[1] queue  KEYS[2] active  KEYS[3] log
// ARGV[1] now(s) ARGV[2] maxConcurrent ARGV[3] sessionTTL(s) ARGV[4] logRetention(s)
const SWEEP_SCRIPT = `
local queueK = KEYS[1]
local activeK = KEYS[2]
local logK = KEYS[3]
local now = tonumber(ARGV[1])
local maxConcurrent = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local logRetention = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', activeK, '-inf', now)

local activeCount = redis.call('ZCARD', activeK)
local capacity = maxConcurrent - activeCount
local admitted = {}

if capacity > 0 then
  local popped = redis.call('ZPOPMIN', queueK, capacity)
  local i = 1
  while i <= #popped do
    local member = popped[i]
    local expiresAt = now + ttl
    redis.call('ZADD', activeK, expiresAt, member)
    redis.call('ZADD', logK, now, member .. ':' .. now)
    table.insert(admitted, member)
    i = i + 2
  end
end

redis.call('ZREMRANGEBYSCORE', logK, '-inf', now - logRetention)

return admitted
`;

async function runSweep(fastify, eventId, batchSize, sessionTTL) {
  const now = Math.floor(Date.now() / 1000);
  try {
    const admitted = await redis.eval(
      SWEEP_SCRIPT,
      [queueKey(eventId), activeKey(eventId), logKey(eventId)],
      [now, batchSize, sessionTTL, ADMISSION_LOG_RETENTION]
    );

    // Stop tracking this event once both sets are empty — keeps
    // vqueue:active-events from growing unbounded across old events.
    const [queueSize, activeSize] = await Promise.all([
      redis.zcard(queueKey(eventId)),
      redis.zcard(activeKey(eventId)),
    ]);
    if (queueSize === 0 && activeSize === 0) {
      await redis.srem(ACTIVE_EVENTS_KEY, eventId);
    }

    return admitted || [];
  } catch (err) {
    fastify.log.error(`[queue] Sweep failed for event ${eventId}: ${err?.message}`);
    return [];
  }
}

async function sweepAllActiveEvents(fastify) {
  let eventIds;
  try {
    eventIds = await redis.smembers(ACTIVE_EVENTS_KEY);
  } catch (err) {
    fastify.log.error(`[queue] Failed to list active-events set: ${err?.message}`);
    return;
  }
  if (!eventIds || eventIds.length === 0) return;

  await Promise.all(
    eventIds.map(async (eventId) => {
      const config = await getQueueConfig(eventId);
      await runSweep(fastify, eventId, config.batchSize, config.sessionTTL);
    })
  );
}

// ── ETA estimation ───────────────────────────────────────────────────────
// Uses a live, empirically-observed admission rate (admissions in the last
// ADMISSION_LOG_WINDOW seconds) rather than a static batchSize/TTL formula,
// since real completion times vary a lot (some pay in 40s, some expire at
// 8:00). Falls back to a conservative assumption until real throughput data
// exists. Returned as a rounded range, not false precision.
async function estimateWait(eventId, aheadCount, batchSize) {
  const now = Math.floor(Date.now() / 1000);
  let admissionsRecently = 0;
  try {
    admissionsRecently = await redis.zcount(logKey(eventId), now - ADMISSION_LOG_WINDOW, now);
  } catch {
    admissionsRecently = 0;
  }

  let ratePerSecond = admissionsRecently / ADMISSION_LOG_WINDOW;
  if (ratePerSecond <= 0) {
    ratePerSecond = batchSize / COLD_START_ASSUMED_COMPLETION_SECS;
  }

  const etaSeconds = aheadCount / ratePerSecond;
  const lowMin = Math.max(0, Math.floor((etaSeconds * 0.7) / 60));
  const highMin = Math.max(lowMin + 1, Math.ceil((etaSeconds * 1.3) / 60));

  return {
    etaSeconds: Math.round(etaSeconds),
    etaLabel: etaSeconds < 60 ? "Less than a minute" : `~${lowMin}-${highMin} min`,
  };
}

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
