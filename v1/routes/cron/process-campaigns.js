// v1/routes/cron/process-campaigns.js
//
// GET /v1/cron/process-campaigns — trigger periodically (every 1–2 min)
// from your external scheduler, same convention as /v1/cron/forecast.

import { runProcessCampaignsCron } from "../../controllers/cron/process-campaigns.controller.js";

export default async function cronProcessCampaignsRoute(fastify, options) {
  fastify.get("/cron/process-campaigns", runProcessCampaignsCron);
}
