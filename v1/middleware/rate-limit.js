// v1/middleware/rate-limit.js
//
// Shared Upstash Redis rate limiter. Originally written for routes
// under v1/mcp/*, each setting its own window/limit without
// re-implementing the Redis calls — now also the backbone of the
// global, backend-wide limiter registered as an onRequest hook in
// server.js, via the same checkRateLimit()/getClientIp() exports.
//
// Fails OPEN: a Redis hiccup never blocks a legit request — it's logged
// by the caller and the request proceeds. Abuse protection is
// best-effort defense-in-depth here, not the primary guard (the MCP
// server itself also rate-limits per session before it ever reaches
// this backend — see spotix-mcp's src/lib/rate-limit.ts).

import { redis } from "../utils/redis-client.js";

/**
 * @param {string} bucket - logical name for this limiter, e.g. "mcp:events"
 * @param {string} identifier - what's being limited, e.g. an IP or API key
 * @param {number} windowSeconds
 * @param {number} maxRequests
 * @returns {Promise<{ allowed: boolean, remaining: number }>}
 */
export async function checkRateLimit(bucket, identifier, windowSeconds, maxRequests) {
  const key = `${bucket}:rl:${identifier}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    return { allowed: count <= maxRequests, remaining: Math.max(0, maxRequests - count) };
  } catch (err) {
    return { allowed: true, remaining: maxRequests, degraded: true };
  }
}

/** Same client-IP resolution used elsewhere in this backend (verify-payment.js). */
export function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return request.ip;
}

/**
 * NX-based single-flight cooldown — only the first caller within
 * windowSeconds for this key succeeds. Used to stop a hammering client
 * from re-triggering an expensive operation (e.g. a fresh Firestore
 * events scan) faster than the cache TTL it would otherwise hit.
 */
export async function claimCooldown(bucket, key, windowSeconds) {
  try {
    const set = await redis.set(`${bucket}:cooldown:${key}`, "1", { nx: true, ex: windowSeconds });
    return set !== null;
  } catch (err) {
    return true; // fail open
  }
}
