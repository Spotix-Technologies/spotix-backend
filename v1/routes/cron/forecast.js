// v1/routes/cron/forecast.js
//
// GET /v1/cron/forecast — pulls Open-Meteo weather for events in the next
// FORECAST_WINDOW_DAYS days. Header: x-cron-secret: <CRON_SECRET>
//
// Fastify route wiring only — see
// v1/controllers/cron/forecast.controller.js for the actual job logic.

import { runForecastCron } from "../../controllers/cron/forecast.controller.js";

export default async function cronForecastRoute(fastify, options) {
  fastify.get("/cron/forecast", runForecastCron);
}
