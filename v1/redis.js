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

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

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
