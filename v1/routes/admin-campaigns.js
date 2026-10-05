/**
 * v1/routes/admin-campaigns.js
 *
 * Internal, service-to-service only (same x-internal-secret convention
 * as routes/campaigns.js) — spotix-admin's own app/api/v1/admin/campaigns/*
 * routes do the real admin/IT session + role check first, then call
 * these. The browser never reaches this backend directly (spec §44/§45).
 */

import { requireInternalSecret } from "../middleware/internal-auth.js";
import { isCampaignEnabled } from "../lib/campaigns/config.js";
import {
  getCampaign,
  listCampaignsForEventAdmin,
  getCampaignRecipients,
  getRetryableRecipients,
  getRecipientHistoryByEmail,
  getGlobalCampaignTotals,
  updateCampaign,
  updateRecipient,
} from "../lib/campaigns/repo.js";
import {
  reserveCampaignCredits, adminAdjustEmailCredits, peekEmailCredits,
  InsufficientCreditsError,
} from "../lib/campaigns/credits.js";
import { adminAdjustSmsCredits, getOrInitSmsCredits } from "../lib/sms/credits.js";
import { listCreditLedger, normalizeKind } from "../lib/campaigns/ledger.js";
import { findUserByEmail } from "../lib/campaigns/users.js";

// Admin lookups (email / phone / credit transactions) only ever show the most
// recent 15 — enough to investigate a case without dumping a whole history.
const ADMIN_RESULT_CAP = 15;
const MAX_TOPUP = 1_000_000;

export default async function adminCampaignsRoute(fastify, options) {
  fastify.addHook("preHandler", (request, reply, done) => {
    if (requireInternalSecret(request, reply)) return;
    done();
  });

  // GET /admin/campaigns/event/:eventId
  fastify.get("/admin/campaigns/event/:eventId", async (request, reply) => {
    const campaigns = await listCampaignsForEventAdmin(request.params.eventId, 100);
    return reply.send({ success: true, campaigns });
  });

  // GET /admin/campaigns/:id
  fastify.get("/admin/campaigns/:id", async (request, reply) => {
    const campaign = await getCampaign(request.params.id);
    if (!campaign) return reply.code(404).send({ success: false, error: "Campaign not found" });
    return reply.send({ success: true, campaign });
  });

  // GET /admin/campaigns/:id/recipients
  fastify.get("/admin/campaigns/:id/recipients", async (request, reply) => {
    const recipients = await getCampaignRecipients(request.params.id, 500);
    return reply.send({ success: true, recipients });
  });

  // GET /admin/campaigns/email/:email
  // The list is capped at the 15 most recent campaigns; the aggregate counts
  // cover the address's whole history (up to the repo's own safety ceiling).
  fastify.get("/admin/campaigns/email/:email", async (request, reply) => {
    const { history, allStatuses } = await getRecipientHistoryByEmail(request.params.email);
    const aggregate = {
      campaignsReceived: allStatuses.length,
      delivered: allStatuses.filter((r) => ["delivered", "opened", "clicked"].includes(r.status)).length,
      opened: allStatuses.filter((r) => r.status === "opened" || r.status === "clicked").length,
      clicked: allStatuses.filter((r) => r.status === "clicked").length,
      bounced: allStatuses.filter((r) => r.status === "bounced").length,
      lastCampaignReceivedAt: history[0]?.created_at || null,
    };
    return reply.send({ success: true, history, aggregate, cap: ADMIN_RESULT_CAP });
  });

  // POST /admin/campaigns/:id/retry
  // Body: { createdBy }
  // Re-reserves one credit per retried recipient — a permanent failure
  // already refunded that credit, so retrying it has to re-reserve
  // rather than assume the reservation is still there (spec §14/§39).
  fastify.post("/admin/campaigns/:id/retry", async (request, reply) => {
    if (!isCampaignEnabled()) return reply.code(403).send({ success: false, error: "Campaigns are not enabled" });

    const { createdBy } = request.body || {};
    const campaign = await getCampaign(request.params.id);
    if (!campaign) return reply.code(404).send({ success: false, error: "Campaign not found" });

    const retryable = await getRetryableRecipients(campaign.id);
    if (!retryable.length) {
      return reply.send({ success: true, retried: 0, message: "Nothing eligible to retry" });
    }

    let retried = 0;
    for (const recipient of retryable) {
      try {
        await reserveCampaignCredits(campaign.organizer_id, campaign.id, campaign.event_id, 1, createdBy || "admin");
      } catch (err) {
        if (err instanceof InsufficientCreditsError) break; // stop — out of credits
        throw err;
      }
      await updateRecipient(recipient.id, {
        status: "pending", next_retry_at: null, last_error: null,
      });
      retried += 1;
    }

    if (retried > 0 && !["processing", "waiting_for_provider"].includes(campaign.status)) {
      await updateCampaign(campaign.id, { status: "waiting_for_provider" });
    }

    return reply.send({
      success: true, retried, skipped: retryable.length - retried,
      message: retried < retryable.length ? "Some recipients skipped — insufficient credits" : undefined,
    });
  });

  // GET /admin/credits/user?email=
  // Admin identifies a booker by EMAIL; credits are keyed on their account id.
  // Returns who they are plus both balances (email + SMS).
  fastify.get("/admin/credits/user", async (request, reply) => {
    const user = await findUserByEmail(request.query.email);
    if (!user) return reply.code(404).send({ success: false, error: "No user found with that email" });
    try {
      const [emailCredits, smsCredits] = await Promise.all([
        peekEmailCredits(user.uid),
        getOrInitSmsCredits(user.uid),
      ]);
      return reply.send({ success: true, user, emailCredits, smsCredits });
    } catch (err) {
      fastify.log.error({ err }, "[admin-campaigns] failed to load user credits");
      return reply.code(500).send({ success: false, error: "Failed to load credits" });
    }
  });

  // POST /admin/credits/topup
  // Body: { email, kind: "email"|"sms", amount, reason, createdBy }
  // amount is a signed whole number: positive tops up, negative corrects.
  // Always ledgered (type "manual") with the reason and the admin's name.
  fastify.post("/admin/credits/topup", async (request, reply) => {
    const { email, kind, amount, reason, createdBy } = request.body || {};
    const cleanReason = String(reason ?? "").trim();
    const delta = Number(amount);

    if (kind !== "email" && kind !== "sms") {
      return reply.code(400).send({ success: false, error: "kind must be email or sms" });
    }
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_TOPUP) {
      return reply.code(400).send({ success: false, error: `amount must be a non-zero whole number (max ${MAX_TOPUP.toLocaleString("en-NG")})` });
    }
    if (!cleanReason) return reply.code(400).send({ success: false, error: "A reason is required" });
    if (cleanReason.length > 500) return reply.code(400).send({ success: false, error: "Reason is too long (max 500 characters)" });

    const user = await findUserByEmail(email);
    if (!user) return reply.code(404).send({ success: false, error: "No user found with that email" });

    try {
      const credits = kind === "email"
        ? await adminAdjustEmailCredits(user.uid, delta, cleanReason, createdBy || "admin")
        : await adminAdjustSmsCredits(user.uid, delta, cleanReason, createdBy || "admin");
      return reply.send({ success: true, kind, user, credits });
    } catch (err) {
      fastify.log.error({ err }, "[admin-campaigns] top-up failed");
      return reply.code(500).send({ success: false, error: "Failed to adjust credits" });
    }
  });

  // GET /admin/credits/transactions?email=&kind=all|email|sms
  // The 15 most recent credit movements for that booker, email + SMS together.
  fastify.get("/admin/credits/transactions", async (request, reply) => {
    const cleanKind = normalizeKind(request.query.kind);
    if (!cleanKind) return reply.code(400).send({ success: false, error: "kind must be all, email or sms" });

    const user = await findUserByEmail(request.query.email);
    if (!user) return reply.code(404).send({ success: false, error: "No user found with that email" });
    try {
      const { transactions } = await listCreditLedger(user.uid, { kind: cleanKind, limit: ADMIN_RESULT_CAP });
      return reply.send({ success: true, transactions, cap: ADMIN_RESULT_CAP });
    } catch (err) {
      fastify.log.error({ err }, "[admin-campaigns] failed to load transactions");
      return reply.code(500).send({ success: false, error: "Failed to load transactions" });
    }
  });

  // GET /admin/campaigns/analytics?since=&until=
  fastify.get("/admin/campaigns/analytics", async (request, reply) => {
    const { since, until } = request.query;
    const totals = await getGlobalCampaignTotals({ since, until });
    return reply.send({ success: true, totals });
  });
}
