// v1/lib/queue/eta.js
//
// Uses a live, empirically-observed admission rate (admissions in the
// last ADMISSION_LOG_WINDOW seconds) rather than a static
// batchSize/TTL formula, since real completion times vary a lot (some
// pay in 40s, some expire at 8:00). Falls back to a conservative
// assumption until real throughput data exists. Returned as a rounded
// range, not false precision.

import { redis } from "../../utils/redis-client.js";
import { logKey, ADMISSION_LOG_WINDOW, COLD_START_ASSUMED_COMPLETION_SECS } from "./constants.js";

export async function estimateWait(eventId, aheadCount, batchSize) {
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
