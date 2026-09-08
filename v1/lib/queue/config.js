// v1/lib/queue/config.js
//
// Per-event queue config (virtualQueueEnabled/queueBatchSize/
// queueSessionTTL), cached in Redis so the sweep loop (every 3s, see
// sweep.js) doesn't hit Firestore every tick — exactly the read volume
// this feature exists to protect against.

import { adminDb } from "../../firebase-admin.js";
import { redis } from "../../redis.js";
import { configCacheKey, CONFIG_CACHE_TTL, DEFAULT_BATCH_SIZE, DEFAULT_SESSION_TTL } from "./constants.js";

export async function getQueueConfig(eventId) {
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
