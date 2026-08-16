// v1/lib/payout/rate-limit.js
//
// Guards every outbound Paystack transfer INITIATION call — this is the
// "rate limiting of course on our end before Paystack does that for us"
// piece. Two independent limits, both enforced with plain Redis
// INCR + PEXPIRE sliding windows against the same Upstash instance
// already wired up in v1/redis.js (no new dependency needed):
//
//   1. Per-user  — `payout:rl:user:{userId}`  → max PER_USER_MAX transfer
//      initiations per PER_USER_WINDOW_MS. Stops one runaway
//      client/tab from hammering the process endpoint for the same
//      requester.
//   2. Global    — `payout:rl:global`          → max GLOBAL_MAX transfer
//      initiations per GLOBAL_WINDOW_MS across all of Spotix. Keeps us
//      comfortably under Paystack's own per-second transfer rate limit
//      regardless of how many users are withdrawing at once.
//
// This only rate-limits the ACT of calling Paystack — it says nothing
// about whether a specific reference has already been processed. That
// idempotency guarantee is separate and lives in processPayoutReference()
// (v1/lib/payout/process.js), which only ever acts on a row that is
// still in status "initializing".

import { redis } from "../../redis.js";

const PER_USER_MAX = 3;
const PER_USER_WINDOW_MS = 10_000; // 3 transfer inits per 10s per user

const GLOBAL_MAX = 8;
const GLOBAL_WINDOW_MS = 10_000; // 8 transfer inits per 10s across all of Spotix

/**
 * Increments a fixed-window counter and returns whether the caller is
 * still under the limit. First hit on a fresh window sets the TTL.
 */
async function checkWindow(key, max, windowMs) {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.pexpire(key, windowMs);
  }
  return count <= max;
}

/**
 * Returns { allowed: true } or { allowed: false, reason, retryAfterMs }.
 * Never throws — a Redis hiccup fails OPEN (allowed: true) rather than
 * blocking real money movement on a rate-limiter outage, but logs loudly
 * so it's visible.
 */
export async function checkPayoutRateLimit(fastify, userId) {
  try {
    const globalOk = await checkWindow("payout:rl:global", GLOBAL_MAX, GLOBAL_WINDOW_MS);
    if (!globalOk) {
      return {
        allowed: false,
        reason: "Too many payouts are being processed right now across Spotix. Please try again in a few seconds.",
        retryAfterMs: GLOBAL_WINDOW_MS,
      };
    }

    const userOk = await checkWindow(`payout:rl:user:${userId}`, PER_USER_MAX, PER_USER_WINDOW_MS);
    if (!userOk) {
      return {
        allowed: false,
        reason: "You're requesting payouts too quickly. Please wait a few seconds and try again.",
        retryAfterMs: PER_USER_WINDOW_MS,
      };
    }

    return { allowed: true };
  } catch (err) {
    fastify.log.error({ err }, "[payout-rate-limit] Redis error — failing open");
    return { allowed: true };
  }
}
