// v1/middleware/rate-limit.js
//
// Shared Upstash Redis rate limiter.
// Note: server.js initializes Fastify with `trustProxy: true`. 
// However, we still explicitly parse the X-Forwarded-For header here 
// to ensure we get the real client IP behind Render's proxy, and not 
// the proxy's internal IP (127.0.0.1).

import { redis } from "../utils/redis-client.js";

/**
 * @param bucket - logical name for this limiter, e.g. "mcp:events"
 * @param identifier - what's being limited, e.g. an IP or API key
 * @param windowSeconds - number of seconds in the window
 * @param maxRequests - max requests allowed in the window
 * @returns A promise resolving to an object with allowed and remaining
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
    // Fail open: if Redis is down, allow the request so the API doesn't go down.
    return { allowed: true, remaining: maxRequests, degraded: true };
  }
}

/** 
 * Returns the real client IP, correctly accounting for Render's proxy.
 * It prioritizes the X-Forwarded-For header (which Render/Cloudflare set)
 * and falls back to request.ip (for local development).
 */
export function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  
  // If we are behind a proxy (Render, Cloudflare), use the real client IP
  if (typeof forwarded === "string" && forwarded.length > 0) {
    // X-Forwarded-For can be a comma-separated list (client, proxy1, proxy2)
    // The first one is the original client IP.
    return forwarded.split(",")[0].trim();
  }
  
  // Fallback for local development (where there is no proxy)
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