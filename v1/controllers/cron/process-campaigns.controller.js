// v1/controllers/cron/process-campaigns.controller.js
//
// GET /v1/cron/process-campaigns — header: x-cron-secret: <CRON_SECRET>
// Mirrors v1/controllers/cron/forecast.controller.js's secret check.
//
//   (no query)          full cycle over every waiting campaign — the hourly
//                       scheduler call, kept as the safety net / retry sweep.
//   ?campaignId=<uuid>  process just that campaign NOW. Called server-to-server
//                       by spotix-booker right after a campaign is started or
//                       resubmitted so it doesn't sit until the next hour.
//                       Replies 202 immediately; the work continues in the
//                       background.

import { runCampaignProcessingCycle, processCampaignNow } from "../../lib/campaigns/worker.js";
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

  const campaignId = request.query?.campaignId;
  if (campaignId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(campaignId))) {
      return reply.code(400).send({ success: false, error: "campaignId must be a uuid" });
    }
    setImmediate(() => {
      processCampaignNow(campaignId, request.log)
        .then((r) => request.log.info({ campaignId, ...r }, "[process-campaigns job] on-demand run finished"))
        .catch((err) => request.log.error({ err, campaignId }, "[process-campaigns job] on-demand run failed"));
    });
    return reply.code(202).send({ success: true, accepted: true, campaignId });
  }

  try {
    const result = await runCampaignProcessingCycle();
    return reply.send({ success: true, ...result });
  } catch (err) {
    request.log.error({ err }, "[process-campaigns job] cycle failed");
    return reply.code(500).send({ success: false, error: "Processing cycle failed" });
  }
}
