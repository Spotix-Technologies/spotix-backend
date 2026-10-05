/**
 * v1/routes/admin-sms.js
 *
 * Internal, service-to-service only — spotix-admin's own
 * app/api/v1/admin/sms-campaigns/* routes do the real admin role check first,
 * then call these. The browser never reaches this backend directly.
 *
 * Statuses: created → approved | rejected → delivered (approved only).
 * Approving/rejecting emails the booker (SES). Rejecting returns the
 * reserved credits to the booker's balance (inside the RPC, atomically).
 */

import { requireInternalSecret } from "../middleware/internal-auth.js";
import {
  getSmsCampaign, listSmsCampaignsAdmin, getSmsNumbersSignedUrl,
  approveSmsCampaign, rejectSmsCampaign, deliverSmsCampaign, getSmsHistoryByPhone,
  SmsNotFoundError, SmsStateError,
} from "../lib/sms/repo.js";
import { normalizeNigerianNumber } from "../lib/sms/phone.js";
import { sendSmsDecisionEmail } from "../lib/sms/notifications.js";

const VALID_STATUSES = new Set(["created", "approved", "rejected", "delivered"]);

function replyForDecisionError(err, reply) {
  if (err instanceof SmsNotFoundError) {
    return reply.code(404).send({ success: false, error: "Campaign not found" });
  }
  if (err instanceof SmsStateError) {
    return reply.code(409).send({ success: false, error: err.message, currentStatus: err.currentStatus });
  }
  return null;
}

export default async function adminSmsRoute(fastify, options) {
  fastify.addHook("preHandler", (request, reply, done) => {
    if (requireInternalSecret(request, reply)) return;
    done();
  });

  // GET /admin/sms/campaigns?status=&limit=
  fastify.get("/admin/sms/campaigns", async (request, reply) => {
    const { status, limit } = request.query;
    if (status && !VALID_STATUSES.has(status)) {
      return reply.code(400).send({ success: false, error: "Invalid status filter" });
    }
    try {
      const campaigns = await listSmsCampaignsAdmin({ status, limit: Math.min(Number(limit) || 100, 200) });
      return reply.send({ success: true, campaigns });
    } catch (err) {
      fastify.log.error({ err }, "[admin-sms] list failed");
      return reply.code(500).send({ success: false, error: "Failed to load bulk SMS campaigns" });
    }
  });

  // GET /admin/sms/phone/:phone — the SMS twin of the email lookup: the 15 most
  // recent bulk SMS campaigns this number was in. Accepts 080…, +234… etc.
  fastify.get("/admin/sms/phone/:phone", async (request, reply) => {
    const parsed = normalizeNigerianNumber(request.params.phone);
    if (!parsed.ok) return reply.code(400).send({ success: false, error: parsed.reason });
    try {
      const { history, totalCampaigns } = await getSmsHistoryByPhone(parsed.number);
      return reply.send({
        success: true,
        phone: parsed.number,
        history,
        aggregate: {
          campaignsIncluded: totalCampaigns,
          lastCampaignAt: history[0]?.created_at || null,
        },
      });
    } catch (err) {
      fastify.log.error({ err }, "[admin-sms] phone lookup failed");
      return reply.code(500).send({ success: false, error: "Failed to look up that number" });
    }
  });

  // GET /admin/sms/campaigns/:id — includes a short-lived signed link to the numbers .txt
  fastify.get("/admin/sms/campaigns/:id", async (request, reply) => {
    try {
      const campaign = await getSmsCampaign(request.params.id);
      if (!campaign) return reply.code(404).send({ success: false, error: "Campaign not found" });
      return reply.send({ success: true, campaign, numbersDownloadUrl: await getSmsNumbersSignedUrl(campaign) });
    } catch (err) {
      fastify.log.error({ err }, "[admin-sms] get failed");
      return reply.code(500).send({ success: false, error: "Failed to load campaign" });
    }
  });

  // POST /admin/sms/campaigns/:id/approve   { adminName }
  fastify.post("/admin/sms/campaigns/:id/approve", async (request, reply) => {
    const { adminName } = request.body || {};
    try {
      const campaign = await approveSmsCampaign(request.params.id, adminName || "admin");
      const emailed = await sendSmsDecisionEmail(campaign, "approved");
      return reply.send({ success: true, campaign, emailed });
    } catch (err) {
      if (replyForDecisionError(err, reply)) return;
      fastify.log.error({ err }, "[admin-sms] approve failed");
      return reply.code(500).send({ success: false, error: "Failed to approve campaign" });
    }
  });

  // POST /admin/sms/campaigns/:id/reject   { reason, adminName }
  fastify.post("/admin/sms/campaigns/:id/reject", async (request, reply) => {
    const { reason, adminName } = request.body || {};
    const cleanReason = String(reason ?? "").trim();
    if (!cleanReason) return reply.code(400).send({ success: false, error: "A reason is required to reject a campaign" });
    if (cleanReason.length > 1000) return reply.code(400).send({ success: false, error: "Reason is too long (max 1000 characters)" });
    try {
      const campaign = await rejectSmsCampaign(request.params.id, cleanReason, adminName || "admin");
      const emailed = await sendSmsDecisionEmail(campaign, "rejected");
      return reply.send({ success: true, campaign, emailed });
    } catch (err) {
      if (replyForDecisionError(err, reply)) return;
      fastify.log.error({ err }, "[admin-sms] reject failed");
      return reply.code(500).send({ success: false, error: "Failed to reject campaign" });
    }
  });

  // POST /admin/sms/campaigns/:id/deliver   { adminName }
  fastify.post("/admin/sms/campaigns/:id/deliver", async (request, reply) => {
    const { adminName } = request.body || {};
    try {
      const campaign = await deliverSmsCampaign(request.params.id, adminName || "admin");
      return reply.send({ success: true, campaign });
    } catch (err) {
      if (replyForDecisionError(err, reply)) return;
      fastify.log.error({ err }, "[admin-sms] deliver failed");
      return reply.code(500).send({ success: false, error: "Failed to mark campaign delivered" });
    }
  });
}
