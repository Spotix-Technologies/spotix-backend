// v1/controllers/cron/forecast.controller.js
//
// Weather forecast cron job logic, extracted from the old
// v1/cron/forecast.js so the route file (v1/routes/cron/forecast.js) is
// just Fastify wiring.
//
// NOTE: this endpoint is not currently registered in server.js's route
// list separately from cron/forecast.js's own auth — server.js DOES
// register this one (unlike v1/cron/payout.js, see that controller's
// note). Left exactly as found.

import { adminDb } from "../../utils/firebase.js";
import { FieldValue } from "firebase-admin/firestore";

const FORECAST_WINDOW_DAYS = 5;
const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
export const DEV_TAG = "API developed and maintained by Spotix Technologies";

function toISODate(date) {
  return date.toISOString().split("T")[0];
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function fetchForecast(lat, lng, eventDate) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    daily: "weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum",
    timezone: "Africa/Lagos",
    start_date: eventDate,
    end_date: eventDate,
  });

  const url = `${OPEN_METEO_BASE}?${params.toString()}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Open-Meteo returned ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

export async function runForecastCron(request, reply) {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    request.log.error("[forecast job] CRON_SECRET env var is not set. Rejecting all requests.");
    return reply.code(401).send({ error: "Unauthorized", reason: "Server misconfiguration", developer: DEV_TAG });
  }

  const secret = request.headers["x-cron-secret"];

  if (!secret) {
    request.log.warn("[forecast job] Unauthorized — no key found in header");
    return reply.code(401).send({ error: "Unauthorized", reason: "No key found in header", developer: DEV_TAG });
  }

  if (secret !== cronSecret) {
    request.log.warn("[forecast job] Unauthorized — incorrect key in header");
    return reply.code(401).send({ error: "Unauthorized", reason: "Incorrect key in header", developer: DEV_TAG });
  }

  // ── 2. Build query window ────────────────────────────────────────────────
  const now = new Date();
  const windowEnd = addDays(now, FORECAST_WINDOW_DAYS);
  const todayStr = toISODate(now);
  const windowEndStr = toISODate(windowEnd);

  request.log.info(`[forecast job] Running. Window: ${todayStr} → ${windowEndStr}`);

  // ── 3. Query pending forecasts within the 5-day window ───────────────────
  // Requires composite index: forecasts [ status ASC, eventDate ASC ]
  let snap;
  try {
    snap = await adminDb
      .collection("forecasts")
      .where("status", "==", "pending")
      .where("eventDate", ">=", todayStr)
      .where("eventDate", "<=", windowEndStr)
      .get();
  } catch (err) {
    request.log.error({ err }, "[forecast job] Firestore query failed — composite index may be missing");
    return reply.code(500).send({
      error: "Database Error",
      message: "Forecast query failed — composite index may be missing",
      details: err.message,
      developer: DEV_TAG,
    });
  }

  if (snap.empty) {
    request.log.info("[forecast job] No pending forecasts in window.");
    return reply.code(200).send({
      success: true,
      message: "No pending forecasts in window",
      processed: 0,
      developer: DEV_TAG,
    });
  }

  request.log.info(`[forecast job] Found ${snap.size} pending forecast(s) in window`);

  // ── 4. Process each forecast ─────────────────────────────────────────────
  const results = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const { eventId, eventLocation, eventDate } = data;
    const ref = adminDb.collection("forecasts").doc(doc.id);

    // Skip if coordinates are missing
    if (eventLocation.lat === null || eventLocation.lng === null) {
      await ref.update({
        status: "skipped",
        skipReason: "Missing lat/lng coordinates",
        processedAt: FieldValue.serverTimestamp(),
      });
      request.log.warn(`[forecast job] Skipped eventId=${eventId} — missing coordinates`);
      results.push({ eventId, status: "skipped", reason: "Missing coordinates" });
      continue;
    }

    try {
      const forecast = await fetchForecast(eventLocation.lat, eventLocation.lng, eventDate);

      const daily = forecast.daily;
      const dayIndex = 0; // only one day returned (start_date === end_date)

      await ref.update({
        status: "fulfilled",
        forecast: {
          weathercode: daily.weathercode[dayIndex] ?? null,
          tempMax: daily.temperature_2m_max[dayIndex] ?? null,
          tempMin: daily.temperature_2m_min[dayIndex] ?? null,
          precipitationMm: daily.precipitation_sum[dayIndex] ?? null,
          units: forecast.daily_units,
          resolvedCoordinates: {
            lat: forecast.latitude,
            lng: forecast.longitude,
          },
        },
        processedAt: FieldValue.serverTimestamp(),
      });

      request.log.info(`[forecast job] ✅ Fulfilled forecast for eventId=${eventId}`);
      results.push({ eventId, status: "fulfilled" });
    } catch (err) {
      request.log.error({ err }, `[forecast job] ❌ Open-Meteo failed for eventId=${eventId}`);

      await ref.update({
        status: "failed",
        error: err.message,
        processedAt: FieldValue.serverTimestamp(),
      });

      results.push({ eventId, status: "failed", reason: err.message });
    }
  }

  const fulfilled = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  request.log.info(`[forecast job] Done. fulfilled=${fulfilled} failed=${failed} skipped=${skipped}`);

  return reply.code(200).send({
    success: true,
    message: "Forecast cron completed",
    summary: { total: results.length, fulfilled, failed, skipped },
    results,
    developer: DEV_TAG,
  });
}
