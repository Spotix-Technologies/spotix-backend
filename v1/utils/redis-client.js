/**
 * v1/redis.js
 *
 * Same Upstash Redis instance used across Spotix services (see
 * spotix-user/src/app/lib/redis.ts and spotix-booker/app/lib/redis.ts).
 * Requires npm i @upstash/redis.
 *
 * Currently used only to invalidate the public voting-poll page's
 * read-through cache (voting-poll-lookup:{pollNameOrId} in
 * spotix-user/src/app/lib/voting-utils.ts) the instant a vote is
 * credited — see the call in voting.js. Everything here is best-effort:
 * a Redis failure must never block a payment webhook, so every call site
 * wraps this in try/catch and only logs on failure.
 *
 * Env vars (same values already provisioned for spotix-user/booker):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

import { Redis } from "@upstash/redis"
import dotenv from "dotenv"

// Every other client module in v1/lib/mail/* (mailjet, resend, ses)
// defensively loads its own env before reading process.env — this file
// was the one exception, which is exactly why the Redis client used to
// come up with url/token undefined if anything ever imported this
// module before the entry point's own dotenv loading ran (see the fix
// in server.js's very first import for the concrete case that hit).
dotenv.config()

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

/**
 * Stale-while-revalidate cache with single-flight refresh, for read-heavy
 * values (e.g. the campaign credit packages list) that don't need to be
 * millisecond-fresh but shouldn't be re-fetched from Firestore/Postgres on
 * every request either.
 *
 * Behavior:
 *  - Fresh cache entry present → return it, no DB hit.
 *  - Entry missing or older than ttlSeconds → exactly one caller wins an
 *    NX lock and re-fetches via `fetcher`, writing the new value back.
 *    Every other concurrent caller reads the (possibly stale) cached
 *    value instead of also hitting the DB — only a true cold start (no
 *    cached value at all yet) falls back to calling `fetcher` directly.
 *  - Any Redis error fails open: falls straight through to `fetcher()`,
 *    same "never block on cache" philosophy as checkRateLimit/claimCooldown
 *    in v1/middleware/rate-limit.js.
 *
 * Callers are responsible for busting `key` themselves (via redis.del)
 * when they know the underlying data changed — see
 * spotix-admin/app/lib/redis-admin.ts's cacheDel() for the convention.
 */
export async function getOrSetCache(key, ttlSeconds, fetcher, { lockTtlSeconds = 30 } = {}) {
  let cached = null
  try {
    cached = await redis.get(key)
  } catch (err) {
    return fetcher()
  }

  const now = Date.now()
  if (cached && typeof cached === "object" && cached.expiresAt > now) {
    return cached.value
  }

  const lockKey = `${key}:lock`
  let gotLock = false
  try {
    gotLock = (await redis.set(lockKey, "1", { nx: true, ex: lockTtlSeconds })) !== null
  } catch (err) {
    gotLock = true // Redis degraded — fail open, treat as if we own the refresh
  }

  if (gotLock) {
    const fresh = await fetcher()
    try {
      await redis.set(key, { value: fresh, expiresAt: now + ttlSeconds * 1000 })
    } catch (err) {
      // best-effort cache write — a failed write just means the next
      // request re-triggers a refresh, not a correctness problem
    }
    return fresh
  }

  // Another request is already refreshing this key right now. Serve
  // what's cached (even if stale) rather than also hammering the DB —
  // only truly nothing cached yet forces a direct fetch here.
  if (cached && typeof cached === "object") return cached.value
  return fetcher()
}

/**
 * Busts the cached lookup for a voting poll. spotix-user caches by
 * whatever string resolved the poll (see pollLookupCacheKey() in
 * voting-utils.ts) — the pollId is always one valid key for that cache
 * regardless of whether the visitor's URL actually used the ID or the
 * poll's name, since getPollByName() tries the flat pollId doc first.
 */
export async function invalidatePollCache(pollId) {
  await redis.del(`voting-poll-lookup:${pollId}`)
}

/**
 * Busts the cached category tree for a group poll — see
 * spotix-booker/app/lib/poll-categories.ts's fetchCategoryTree(), which
 * writes to this exact same key (`poll-categories:{pollId}`) on the same
 * shared Redis instance. Called from allocate-vote.js on every group-poll
 * vote, since a vote changes a contestant's count inside that cached tree.
 */
export async function invalidateCategoryTreeCache(pollId) {
  await redis.del(`poll-categories:${pollId}`)
}
