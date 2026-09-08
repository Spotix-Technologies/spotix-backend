// v1/lib/queue/sweep.js
//
// Admission is a single atomic Lua script (SWEEP_SCRIPT below): evict
// expired active sessions, compute freed capacity, ZPOPMIN that many off
// the queue (lowest score = next up), and promote them into the active
// set. Runs on a fixed interval for every tracked event (queue.js's
// setInterval calls sweepAllActiveEvents), AND immediately on
// /queue/complete so a freed slot doesn't sit idle until the next tick.

import { redis } from "../../redis.js";
import { queueKey, activeKey, logKey, ACTIVE_EVENTS_KEY, ADMISSION_LOG_RETENTION } from "./constants.js";
import { getQueueConfig } from "./config.js";

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

export async function runSweep(fastify, eventId, batchSize, sessionTTL) {
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

export async function sweepAllActiveEvents(fastify) {
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
