// v1/controllers/cron/process-campaigns.controller.js
//
// GET /v1/cron/process-campaigns — header: x-cron-secret: <CRON_SECRET>
// Mirrors v1/controllers/cron/forecast.controller.js's secret check.

import { runCampaignProcessingCycle } from "../../lib/campaigns/worker.js";
import { isCampaignEnabled } from "../../lib/campaigns/config.js";

export async function runProcessCampaignsCron(request, reply) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    request.log.error("[process-campaigns job] CRON_SECRET env var is not set. Rejecting all requests.");
    return reply.code(500).send({ success: false, error: "Server misconfigured" });
  }
  const secret = request.headers["x-cron-secret"];
  if (!secret || secret !== cronSecret) {
    return reply.code(401).send({ success: false, error: "Unauthorized" });
  }

  if (!isCampaignEnabled()) {
    return reply.send({ success: true, skipped: true, reason: "isCampaignOn is not set to 1" });
  }

  try {
    const result = await runCampaignProcessingCycle();
    return reply.send({ success: true, ...result });
  } catch (err) {
    request.log.error({ err }, "[process-campaigns job] cycle failed");
    return reply.code(500).send({ success: false, error: "Processing cycle failed" });
  }
}
