// v1/controllers/queue.controller.js
//
// Virtual Queue API handlers, extracted from the old v1/queue.js so the
// route file (v1/routes/queue.js) is just Fastify wiring + the background
// sweep interval. Admission, config caching, token signing, and ETA
// estimation still live in v1/lib/queue/ — see that folder for the data
// model details.

import crypto from "crypto";
import { redis } from "../utils/redis-client.js";
import { JOIN_WINDOW_SECONDS, queueKey, activeKey, ACTIVE_EVENTS_KEY } from "../lib/queue/constants.js";
import { signToken, verifyToken } from "../lib/queue/token.js";
import { getQueueConfig } from "../lib/queue/config.js";
import { runSweep } from "../lib/queue/sweep.js";
import { estimateWait } from "../lib/queue/eta.js";

export const DEV_TAG = "API developed and maintained by Spotix Technologies";

export async function getQueueConfigHandler(request, reply) {
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
}

export async function joinQueue(request, reply) {
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
    request.log.error(`[queue] join error: ${error?.message}`);
    return reply.code(500).send({
      error: "Internal Server Error",
      message: "Failed to join queue",
      developer: DEV_TAG,
    });
  }
}

export async function getQueueStatus(request, reply) {
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
    request.log.error(`[queue] status error: ${error?.message}`);
    return reply.code(500).send({
      error: "Internal Server Error",
      message: "Failed to check queue status",
      developer: DEV_TAG,
    });
  }
}

// Releases a held checkout slot the instant checkout finishes, instead of
// waiting for the session TTL to expire, and immediately tries to admit
// the next person rather than waiting for the next sweep tick. Always
// 200 — this must never block a buyer's payment success flow.
export async function completeQueue(request, reply) {
  try {
    const { eventId, token } = request.body || {};
    if (!eventId || !token) {
      return reply.code(200).send({ success: false, developer: DEV_TAG });
    }
    await redis.zrem(activeKey(eventId), token);
    const config = await getQueueConfig(eventId);
    runSweep(request.server, eventId, config.batchSize, config.sessionTTL).catch(() => {});
    return reply.code(200).send({ success: true, developer: DEV_TAG });
  } catch (error) {
    request.log.warn(`[queue] complete error (non-blocking): ${error?.message}`);
    return reply.code(200).send({ success: false, developer: DEV_TAG });
  }
}

// Best-effort — a buyer closing the tab while still waiting frees their
// spot instead of holding it uselessly. Always 200.
export async function leaveQueue(request, reply) {
  try {
    const { eventId, token } = request.body || {};
    if (!eventId || !token) {
      return reply.code(200).send({ success: false, developer: DEV_TAG });
    }
    await redis.zrem(queueKey(eventId), token);
    return reply.code(200).send({ success: true, developer: DEV_TAG });
  } catch (error) {
    request.log.warn(`[queue] leave error (non-blocking): ${error?.message}`);
    return reply.code(200).send({ success: false, developer: DEV_TAG });
  }
}

export async function queueHealth(request, reply) {
  return reply.code(200).send({
    status: "healthy",
    service: "Virtual Queue API",
    timestamp: new Date().toISOString(),
    developer: DEV_TAG,
  });
}
