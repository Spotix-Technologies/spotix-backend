/**
 * v1/routes/campaigns.js
 *
 * Internal, service-to-service only — same x-internal-secret convention
 * as v1/payout-process.js. spotix-booker's own /api/campaigns/* routes
 * verify the organizer's spotix_at cookie and event ownership FIRST,
 * then call these with the already-trusted userId/eventId. The browser
 * never talks to this backend directly for campaigns (spec §44/§45).
 *
 * Phase 1 scope: campaign CRUD + credit reservation. Actual SES/Resend
 * sending, webhooks, and retries land in Phase 2 — POST /:id/start here
 * reserves credits and enqueues the campaign in "waiting_for_provider"
 * (spec §31) since no delivery worker exists yet; nothing is silently
 * pretended to have sent.
 */

import { requireInternalSecret } from "../middleware/internal-auth.js";
import { isCampaignEnabled, isValidationAllowed } from "../lib/campaigns/config.js";
import { submitCampaign, REVIEW_MESSAGE } from "../lib/campaigns/review.js";
import { getOrInitEmailCredits } from "../lib/campaigns/credits.js";
import { listCreditLedger, normalizeKind } from "../lib/campaigns/ledger.js";
import { listAllCampaigns } from "../lib/campaigns/list.js";
import {
  createCampaign,
  getCampaign,
  listCampaignsForEvent,
  insertRecipients,
  updateCampaign,
  dedupeRecipients,
  upsertContacts,
  getCampaignRecipients,
  getRecipientLedger,
} from "../lib/campaigns/repo.js";
import { getActivePackages } from "../lib/campaigns/packages.js";
import { getPurchaseStatus } from "../lib/campaigns/purchase-status.js";
import { isValidTemplateId, TEMPLATE_IDS } from "../lib/campaigns/templates.js";
import { renderCampaignEmailHtml } from "../lib/campaigns/email-render.js";
import {
  initCreditPurchase, verifyAndFulfillPurchase,
  PackageNotFoundError, PackageInactiveError,
} from "../lib/campaigns/billing.js";

function campaignDisabledResponse(reply) {
  return reply.code(403).send({ success: false, error: "Campaigns are not enabled yet" });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function campaignsRoute(fastify, options) {
  fastify.addHook("preHandler", (request, reply, done) => {
    if (requireInternalSecret(request, reply)) return; // already replied 401
    done();
  });

  // GET /campaign-credits?organizerId=
  // Email credits belong to the booker's account (like SMS credits) — one
  // balance shared by every event they own.
  fastify.get("/campaign-credits", async (request, reply) => {
    const { organizerId } = request.query;
    if (!organizerId) {
      return reply.code(400).send({ success: false, error: "organizerId is required" });
    }
    try {
      const credits = await getOrInitEmailCredits(organizerId);
      return reply.send({ success: true, credits });
    } catch (err) {
      fastify.log.error({ err }, "[campaigns] failed to init/get credits");
      return reply.code(500).send({ success: false, error: "Failed to load credits" });
    }
  });

  // GET /campaign-transactions?organizerId=&kind=all|email|sms&limit=&cursor=
  // Email + SMS credit movements for one booker, newest first. Powers the
  // dashboard's "recent 10" card (limit=10) and the /campaign/transactions
  // infinite-scroll page (limit=25 + cursor). See lib/campaigns/ledger.js.
  fastify.get("/campaign-transactions", async (request, reply) => {
    const { organizerId, kind, limit, cursor } = request.query;
    if (!organizerId) {
      return reply.code(400).send({ success: false, error: "organizerId is required" });
    }
    const cleanKind = normalizeKind(kind);
    if (!cleanKind) {
      return reply.code(400).send({ success: false, error: "kind must be all, email or sms" });
    }
    try {
      const result = await listCreditLedger(organizerId, { kind: cleanKind, limit, cursor });
      return reply.send({ success: true, ...result });
    } catch (err) {
      if (err?.message === "invalid_cursor") {
        return reply.code(400).send({ success: false, error: "Invalid cursor" });
      }
      fastify.log.error({ err }, "[campaigns] failed to load credit transactions");
      return reply.code(500).send({ success: false, error: "Failed to load transactions" });
    }
  });

  // GET /campaigns/config — lets the frontend know, before the booker
  // even opens the Design step, whether their message will go through
  // the moderation review (so it can show a heads-up + the "reviewing"
  // copy at the right moment instead of surprising them at submit).
  fastify.get("/campaigns/config", async (request, reply) => {
    return reply.send({ success: true, validationRequired: isValidationAllowed() });
  });

  // GET /campaigns?eventId=&limit=
  fastify.get("/campaigns", async (request, reply) => {
    const { eventId, limit } = request.query;
    if (!eventId) return reply.code(400).send({ success: false, error: "eventId is required" });
    const cleanLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const campaigns = await listCampaignsForEvent(eventId, cleanLimit);
    return reply.send({ success: true, campaigns });
  });

  // GET /campaign-list?organizerId=&kind=all|email|sms&limit=&cursor=
  // Every campaign the booker has made — email and SMS together, across all
  // their events, newest first. Powers /campaign/list (first 15, then more as
  // the page scrolls). See lib/campaigns/list.js.
  fastify.get("/campaign-list", async (request, reply) => {
    const { organizerId, kind, limit, cursor } = request.query;
    if (!organizerId) return reply.code(400).send({ success: false, error: "organizerId is required" });
    const cleanKind = normalizeKind(kind);
    if (!cleanKind) return reply.code(400).send({ success: false, error: "kind must be all, email or sms" });
    try {
      const result = await listAllCampaigns(organizerId, { kind: cleanKind, limit, cursor });
      return reply.send({ success: true, ...result });
    } catch (err) {
      if (err?.message === "invalid_cursor") {
        return reply.code(400).send({ success: false, error: "Invalid cursor" });
      }
      fastify.log.error({ err }, "[campaigns] failed to list campaigns");
      return reply.code(500).send({ success: false, error: "Failed to load campaigns" });
    }
  });

  // GET /campaigns/:id
  fastify.get("/campaigns/:id", async (request, reply) => {
    const campaign = await getCampaign(request.params.id);
    if (!campaign) return reply.code(404).send({ success: false, error: "Campaign not found" });
    return reply.send({ success: true, campaign });
  });

  // GET /campaigns/:id/recipients — per-recipient send status for the
  // detail page's recipient table. Ownership is checked by the caller
  // (spotix-booker's route) the same way as everywhere else in this
  // file; this endpoint itself just trusts the internal secret.
  //
  // ?all=1 lifts the 500 cap (up to CLONE_RECIPIENTS_LIMIT in repo.js) —
  // used by the "clone this campaign" flow in spotix-booker, which
  // needs the complete original audience, not just the first page.
  fastify.get("/campaigns/:id/recipients", async (request, reply) => {
    const campaign = await getCampaign(request.params.id);
    if (!campaign) return reply.code(404).send({ success: false, error: "Campaign not found" });
    const recipients = await getCampaignRecipients(request.params.id, request.query.all ? "all" : 500);
    return reply.send({ success: true, recipients });
  });

  // GET /campaigns/:id/recipients/:recipientId/ledger — the full,
  // immutable event history for ONE recipient on this campaign (spec
  // ask: "ledger" — sentAt/deliveredAt/openedAt/clickedAt/delayedAt/
  // failedAt etc, plus which link each click was for). Ownership is
  // checked by the caller (spotix-booker's route), same convention as
  // every other campaigns endpoint here.
  fastify.get("/campaigns/:id/recipients/:recipientId/ledger", async (request, reply) => {
    const ledger = await getRecipientLedger(request.params.id, request.params.recipientId);
    if (!ledger) return reply.code(404).send({ success: false, error: "Recipient not found on this campaign" });
    return reply.send({ success: true, ...ledger });
  });

  // POST /campaigns
  // Body: { eventId, organizerId, eventNameSnapshot, eventSlugSnapshot, name,
  //         recipients: [{name,email}], templateId, messageText, brandColor,
  //         replyToAddress, ctaText, eventVenueSnapshot, eventDateSnapshot,
  //         eventStartSnapshot, eventEndSnapshot, ticketPricesSnapshot,
  //         isFreeSnapshot }
  // The event*Snapshot/ticketPricesSnapshot/isFreeSnapshot fields exist
  // purely for the moderation layer's Gemini prompt (spec ask: inject
  // the real event name/location/date/time/prices so a booker
  // contradicting their own event gets flagged) — they're stored
  // alongside the existing eventNameSnapshot/eventSlugSnapshot and never
  // used for anything else.
  fastify.post("/campaigns", async (request, reply) => {
    if (!isCampaignEnabled()) return campaignDisabledResponse(reply);

    const {
      eventId, organizerId, eventNameSnapshot, eventSlugSnapshot, name, recipients,
      templateId, messageText, brandColor, replyToAddress, ctaText,
      eventVenueSnapshot, eventDateSnapshot, eventStartSnapshot, eventEndSnapshot,
      ticketPricesSnapshot, isFreeSnapshot, organizerEmail, organizerName,
    } = request.body || {};
    if (!eventId || !organizerId || !eventNameSnapshot || !eventSlugSnapshot || !name) {
      return reply.code(400).send({ success: false, error: "Missing required campaign fields" });
    }
    if (templateId && !isValidTemplateId(templateId)) {
      return reply.code(400).send({ success: false, error: `templateId must be one of: ${TEMPLATE_IDS.join(", ")}` });
    }
    if (brandColor && !/^#[0-9a-fA-F]{6}$/.test(brandColor)) {
      return reply.code(400).send({ success: false, error: "brandColor must be a 6-digit hex color" });
    }
    // Optional — a booker can leave this blank and replies just go
    // nowhere useful (the notification@ address isn't monitored).
    if (replyToAddress && !EMAIL_RE.test(String(replyToAddress).trim())) {
      return reply.code(400).send({ success: false, error: "replyToAddress must be a valid email address" });
    }

    // Snapshot the booker's current statistics entitlement onto the
    // campaign row. This is a snapshot at creation time, not a live
    // link — email_credits.statistics_enabled (set by a Paystack
    // purchase) is the actual source of truth used for gating what a
    // booker sees; this column exists for a per-campaign record of what
    // the campaign was created with.
    const credits = await getOrInitEmailCredits(organizerId);
    const campaign = await createCampaign({
      eventId, organizerId, eventNameSnapshot, eventSlugSnapshot, name,
      statisticsEnabled: !!credits.statistics_enabled,
      templateId, messageText, brandColor, ctaText,
      replyToAddress: replyToAddress ? String(replyToAddress).trim().toLowerCase() : null,
      eventVenueSnapshot, eventDateSnapshot, eventStartSnapshot, eventEndSnapshot,
      ticketPricesSnapshot, isFreeSnapshot, organizerEmail, organizerName,
    });

    const dedupedRecipients = dedupeRecipients(recipients);
    // §60: credits are charged on final unique valid recipients, never
    // on raw uploaded/loaded row count — dedupe happens before anything
    // is persisted or counted.
    if (dedupedRecipients.length) {
      await insertRecipients(campaign.id, dedupedRecipients);
      // Reusable contacts table (spec §9) — Phase 1 only sources
      // "event_attendee", Phase 4 adds "previous_event"/"external_import".
      await upsertContacts(organizerId, dedupedRecipients, "event_attendee");
    }
    const updated = await updateCampaign(campaign.id, { total_recipients: dedupedRecipients.length });

    return reply.code(201).send({ success: true, campaign: updated, validationRequired: isValidationAllowed() });
  });

  // Turns a submitCampaign() outcome into the HTTP response. Shared by
  // /start and /resubmit so both behave identically.
  function respondToSubmit(reply, outcome) {
    if (outcome.outcome === "flagged") {
      const c = outcome.campaign;
      return reply.code(422).send({
        success: false,
        error: "flagged_by_moderation",
        message: c.moderation_reason,
        suggestion: c.moderation_suggestion,
        category: c.moderation_category,
        campaign: c,
      });
    }
    if (outcome.outcome === "insufficient_credits") {
      return reply.code(402).send({
        success: false,
        error: "insufficient_credits",
        available: outcome.available,
        required: outcome.required,
      });
    }
    if (outcome.outcome === "pending_review") {
      return reply.send({ success: true, pendingReview: true, campaign: outcome.campaign, message: REVIEW_MESSAGE });
    }
    return reply.send({ success: true, campaign: outcome.campaign, message: "The campaign will resume soon." });
  }

  // POST /campaigns/:id/start
  // Body: { organizerId }
  // The wordlist check always runs here (instantly). With
  // isValidationAllowed on, the AI review then happens in the
  // background (v1/lib/campaigns/review.js, driven by the scheduler);
  // with it off, the campaign is queued straight away.
  fastify.post("/campaigns/:id/start", async (request, reply) => {
    if (!isCampaignEnabled()) return campaignDisabledResponse(reply);

    const { organizerId } = request.body || {};
    const campaign = await getCampaign(request.params.id);
    if (!campaign) return reply.code(404).send({ success: false, error: "Campaign not found" });
    if (campaign.organizer_id !== organizerId) {
      return reply.code(403).send({ success: false, error: "Forbidden" });
    }
    if (campaign.status !== "draft") {
      return reply.code(409).send({ success: false, error: `Campaign already ${campaign.status}` });
    }
    if (!campaign.total_recipients) {
      return reply.code(400).send({ success: false, error: "Campaign has no recipients" });
    }

    try {
      return respondToSubmit(reply, await submitCampaign(campaign, organizerId));
    } catch (err) {
      fastify.log.error({ err }, "[campaigns] start failed");
      return reply.code(500).send({ success: false, error: "Failed to start campaign" });
    }
  });

  // POST /campaigns/:id/resubmit
  // Body: { organizerId, templateId, messageText, brandColor, ctaText }
  // Only for a "flagged" campaign, and only the design fields can change
  // — the audience and details (name/subject, event) are locked. Then it
  // goes through exactly the same pipeline as a fresh start.
  fastify.post("/campaigns/:id/resubmit", async (request, reply) => {
    if (!isCampaignEnabled()) return campaignDisabledResponse(reply);

    const { organizerId, templateId, messageText, brandColor, ctaText } = request.body || {};
    const campaign = await getCampaign(request.params.id);
    if (!campaign) return reply.code(404).send({ success: false, error: "Campaign not found" });
    if (campaign.organizer_id !== organizerId) {
      return reply.code(403).send({ success: false, error: "Forbidden" });
    }
    if (campaign.status !== "flagged") {
      return reply.code(409).send({ success: false, error: "Only a flagged campaign can be edited and resubmitted" });
    }
    if (templateId && !isValidTemplateId(templateId)) {
      return reply.code(400).send({ success: false, error: `templateId must be one of: ${TEMPLATE_IDS.join(", ")}` });
    }
    if (brandColor && !/^#[0-9a-fA-F]{6}$/.test(brandColor)) {
      return reply.code(400).send({ success: false, error: "brandColor must be a 6-digit hex color" });
    }

    try {
      const edited = await updateCampaign(campaign.id, {
        template_id: templateId || campaign.template_id,
        message_text: typeof messageText === "string" ? messageText : campaign.message_text,
        brand_color: brandColor || campaign.brand_color,
        cta_text: (typeof ctaText === "string" && ctaText.trim()) ? ctaText.trim().slice(0, 40) : campaign.cta_text,
        status: "draft",
        moderation_status: "not_required",
      });
      const outcome = await submitCampaign(edited, organizerId);
      // Not enough credits: put it back to "flagged" so the booker can
      // still find it and resume once they've topped up.
      if (outcome.outcome === "insufficient_credits") await updateCampaign(campaign.id, { status: "flagged" });
      return respondToSubmit(reply, outcome);
    } catch (err) {
      fastify.log.error({ err }, "[campaigns] resubmit failed");
      return reply.code(500).send({ success: false, error: "Failed to resubmit campaign" });
    }
  });

  // POST /campaigns/preview
  // Body: { eventNameSnapshot, eventSlugSnapshot, templateId, messageText, brandColor }
  // Stateless — renders the exact same HTML sendViaResend/sendViaSES will
  // send (reuses renderCampaignEmailHtml directly), without creating or
  // touching any campaign row. Used by the Design step of campaign
  // creation, and can just as well render an existing draft. The
  // unsubscribe link is a "#" placeholder since there's no real
  // organizer/email pair to sign a token for yet.
  fastify.post("/campaigns/preview", async (request, reply) => {
    const { eventNameSnapshot, eventSlugSnapshot, templateId, messageText, brandColor, ctaText } = request.body || {};
    if (!eventNameSnapshot) {
      return reply.code(400).send({ success: false, error: "eventNameSnapshot is required" });
    }
    if (templateId && !isValidTemplateId(templateId)) {
      return reply.code(400).send({ success: false, error: `templateId must be one of: ${TEMPLATE_IDS.join(", ")}` });
    }
    if (brandColor && !/^#[0-9a-fA-F]{6}$/.test(brandColor)) {
      return reply.code(400).send({ success: false, error: "brandColor must be a 6-digit hex color" });
    }

    const html = renderCampaignEmailHtml(
      {
        event_name_snapshot: eventNameSnapshot,
        event_slug_snapshot: eventSlugSnapshot || "",
        template_id: templateId || "classic",
        message_text: messageText || "",
        brand_color: brandColor || "#6D28D9",
        cta_text: ctaText || "View Event",
      },
      "#"
    );
    return reply.send({ success: true, html });
  });

  // GET /campaign-credit-packages
  fastify.get("/campaign-credit-packages", async (request, reply) => {
    try {
      const packages = await getActivePackages();
      if (!packages.length) {
        // spec §12 — exact copy, no checkout possible without a package.
        return reply.send({ success: true, packages: [], message: "Email credits aren't configured yet. Check back later" });
      }
      return reply.send({ success: true, packages });
    } catch (err) {
      fastify.log.error({ err }, "[campaigns] failed to load packages");
      return reply.code(500).send({ success: false, error: "Failed to load packages" });
    }
  });

  // POST /campaign-credit-purchase
  // Body: { organizerId, email, name, packageId }
  // Credits are bought for the booker's account, not an event. Statistics
  // are no longer a separate paid add-on — every package purchase includes
  // analytics, so there's nothing left to toggle here.
  fastify.post("/campaign-credit-purchase", async (request, reply) => {
    const { organizerId, email, name, packageId } = request.body || {};
    if (!organizerId || !email || !packageId) {
      return reply.code(400).send({ success: false, error: "Missing required purchase fields" });
    }
    try {
      const purchase = await initCreditPurchase({ organizerId, email, name, packageId });
      return reply.code(201).send({ success: true, ...purchase });
    } catch (err) {
      if (err instanceof PackageNotFoundError) return reply.code(404).send({ success: false, error: "Package not found" });
      if (err instanceof PackageInactiveError) return reply.code(400).send({ success: false, error: "Package is not active" });
      fastify.log.error({ err }, "[campaigns] failed to init purchase");
      return reply.code(500).send({ success: false, error: "Failed to start purchase" });
    }
  });

  // POST /campaign-credit-purchase/verify
  // Body: { reference }
  // Called by the client right after the Paystack popup reports success,
  // for immediate UI feedback — the webhook (v1/webhook.js) is the
  // authoritative fulfillment path and hits this same idempotent
  // function, so a client that never calls this still gets credited.
  fastify.post("/campaign-credit-purchase/verify", async (request, reply) => {
    const { reference } = request.body || {};
    if (!reference) return reply.code(400).send({ success: false, error: "reference is required" });
    try {
      const result = await verifyAndFulfillPurchase(reference);
      return reply.send(result);
    } catch (err) {
      fastify.log.error({ err }, "[campaigns] purchase verify failed");
      return reply.code(500).send({ success: false, error: "Failed to verify purchase" });
    }
  });

  // GET /campaign-credit-purchase/status?reference=&organizerId=
  // One lookup for BOTH email and SMS credit purchases, by reference alone —
  // powers the booker's "?ref=… in the URL" receipt, so a buyer who left the
  // browser to finish paying (bank app, USSD) and came back to a reloaded page
  // still sees whether it worked. If still pending, this asks Paystack now.
  fastify.get("/campaign-credit-purchase/status", async (request, reply) => {
    const { reference, organizerId } = request.query;
    if (!reference || !organizerId) {
      return reply.code(400).send({ success: false, error: "reference and organizerId are required" });
    }
    try {
      const purchase = await getPurchaseStatus(String(reference), String(organizerId));
      if (!purchase) return reply.code(404).send({ success: false, error: "Purchase not found" });
      return reply.send({ success: true, purchase });
    } catch (err) {
      fastify.log.error({ err }, "[campaigns] purchase status failed");
      return reply.code(500).send({ success: false, error: "Failed to check purchase status" });
    }
  });
}
