/**
 * v1/routes/sms-campaigns.js
 *
 * Booker-facing bulk SMS endpoints. Internal, service-to-service only (same
 * x-internal-secret convention as routes/campaigns.js): spotix-booker's own
 * /api/sms/* routes verify the booker's session + event ownership first and
 * pass the already-trusted organizerId / email / username down.
 */

import { requireInternalSecret } from "../middleware/internal-auth.js";
import { isCampaignEnabled } from "../lib/campaigns/config.js";
import {
  getSmsPricingConfig, quoteSmsPurchase,
  SmsNotConfiguredError, SmsInvalidQuantityError, SmsInvalidDiscountError,
} from "../lib/sms/pricing.js";
import { getOrInitSmsCredits, InsufficientSmsCreditsError } from "../lib/sms/credits.js";
import { initSmsCreditPurchase, verifyAndFulfillSmsPurchase } from "../lib/sms/billing.js";
import {
  createSmsCampaign, listSmsCampaignsForOrganizer, getSmsCampaign, getSmsCampaignNumbers, getSmsCampaignTimeline,
  SmsValidationError, MAX_SMS_MESSAGE_LENGTH,
} from "../lib/sms/repo.js";

/** Maps the typed errors above to HTTP responses. Returns true if handled. */
function replyForError(err, reply) {
  if (err instanceof SmsNotConfiguredError) {
    return reply.code(400).send({ success: false, error: "not_configured", message: "Bulk SMS isn't available yet. Check back later." });
  }
  if (err instanceof SmsInvalidQuantityError) {
    return reply.code(400).send({ success: false, error: err.code, message: err.message, moq: err.moq });
  }
  if (err instanceof SmsInvalidDiscountError) {
    return reply.code(400).send({ success: false, error: "invalid_discount", message: err.message });
  }
  if (err instanceof InsufficientSmsCreditsError) {
    return reply.code(402).send({ success: false, error: "insufficient_credits", available: err.available, required: err.required });
  }
  if (err instanceof SmsValidationError) {
    return reply.code(400).send({ success: false, error: "validation_failed", message: err.message, invalid: err.invalid });
  }
  return null;
}

export default async function smsCampaignsRoute(fastify, options) {
  fastify.addHook("preHandler", (request, reply, done) => {
    if (requireInternalSecret(request, reply)) return;
    done();
  });

  // GET /sms/credits?organizerId=
  fastify.get("/sms/credits", async (request, reply) => {
    const { organizerId } = request.query;
    if (!organizerId) return reply.code(400).send({ success: false, error: "organizerId is required" });
    try {
      const credits = await getOrInitSmsCredits(organizerId);
      return reply.send({ success: true, credits });
    } catch (err) {
      fastify.log.error({ err }, "[sms] failed to load credits");
      return reply.code(500).send({ success: false, error: "Failed to load SMS credits" });
    }
  });

  // GET /sms/pricing — base price, MOQ and volume thresholds for the buy modal.
  fastify.get("/sms/pricing", async (request, reply) => {
    try {
      const config = await getSmsPricingConfig();
      return reply.send({
        success: true,
        configured: config.configured,
        basePrice: config.basePrice,
        moq: config.moq,
        tiers: config.tiers,
        maxMessageLength: MAX_SMS_MESSAGE_LENGTH,
      });
    } catch (err) {
      fastify.log.error({ err }, "[sms] failed to load pricing");
      return reply.code(500).send({ success: false, error: "Failed to load pricing" });
    }
  });

  // POST /sms/quote   { quantity, discountCode? }
  fastify.post("/sms/quote", async (request, reply) => {
    const { quantity, discountCode } = request.body || {};
    try {
      const quote = await quoteSmsPurchase(Number(quantity), discountCode);
      return reply.send({ success: true, quote });
    } catch (err) {
      if (replyForError(err, reply)) return;
      fastify.log.error({ err }, "[sms] quote failed");
      return reply.code(500).send({ success: false, error: "Failed to calculate price" });
    }
  });

  // POST /sms/credit-purchase   { organizerId, email, name, quantity, discountCode? }
  fastify.post("/sms/credit-purchase", async (request, reply) => {
    const { organizerId, email, name, quantity, discountCode } = request.body || {};
    if (!organizerId || !email || !quantity) {
      return reply.code(400).send({ success: false, error: "Missing required purchase fields" });
    }
    try {
      const purchase = await initSmsCreditPurchase({ organizerId, email, name, quantity: Number(quantity), discountCode });
      return reply.code(201).send({ success: true, ...purchase });
    } catch (err) {
      if (replyForError(err, reply)) return;
      fastify.log.error({ err }, "[sms] failed to init purchase");
      return reply.code(500).send({ success: false, error: "Failed to start purchase" });
    }
  });

  // POST /sms/credit-purchase/verify   { reference }
  fastify.post("/sms/credit-purchase/verify", async (request, reply) => {
    const { reference } = request.body || {};
    if (!reference) return reply.code(400).send({ success: false, error: "reference is required" });
    try {
      return reply.send(await verifyAndFulfillSmsPurchase(reference));
    } catch (err) {
      fastify.log.error({ err }, "[sms] purchase verify failed");
      return reply.code(500).send({ success: false, error: "Failed to verify purchase" });
    }
  });

  // GET /sms/campaigns?organizerId=&limit=
  fastify.get("/sms/campaigns", async (request, reply) => {
    const { organizerId, limit } = request.query;
    if (!organizerId) return reply.code(400).send({ success: false, error: "organizerId is required" });
    const cleanLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    try {
      return reply.send({ success: true, campaigns: await listSmsCampaignsForOrganizer(organizerId, cleanLimit) });
    } catch (err) {
      fastify.log.error({ err }, "[sms] failed to list campaigns");
      return reply.code(500).send({ success: false, error: "Failed to load bulk SMS campaigns" });
    }
  });

  // GET /sms/campaigns/:id?organizerId=
  // Includes the campaign's timeline (created / approved / rejected /
  // delivered, each with its exact time) from the append-only ledger.
  fastify.get("/sms/campaigns/:id", async (request, reply) => {
    const campaign = await getSmsCampaign(request.params.id);
    if (!campaign || campaign.organizer_id !== request.query.organizerId) {
      return reply.code(404).send({ success: false, error: "Campaign not found" });
    }
    try {
      const timeline = await getSmsCampaignTimeline(campaign.id);
      return reply.send({ success: true, campaign, timeline });
    } catch (err) {
      fastify.log.error({ err }, "[sms] failed to load timeline");
      return reply.code(500).send({ success: false, error: "Failed to load campaign" });
    }
  });

  // GET /sms/campaigns/:id/numbers?organizerId=  — for "edit & resend"
  fastify.get("/sms/campaigns/:id/numbers", async (request, reply) => {
    const campaign = await getSmsCampaign(request.params.id);
    if (!campaign || campaign.organizer_id !== request.query.organizerId) {
      return reply.code(404).send({ success: false, error: "Campaign not found" });
    }
    try {
      return reply.send({ success: true, numbers: await getSmsCampaignNumbers(campaign) });
    } catch (err) {
      fastify.log.error({ err }, "[sms] failed to read numbers file");
      return reply.code(500).send({ success: false, error: "Couldn't load the numbers for that campaign" });
    }
  });

  // POST /sms/campaigns
  // Body: { organizerId, organizerEmail, organizerUsername, eventId, eventName, name, message, numbers: string[] }
  fastify.post("/sms/campaigns", async (request, reply) => {
    if (!isCampaignEnabled()) return reply.code(403).send({ success: false, error: "Campaigns are not enabled yet" });

    const { organizerId, organizerEmail, organizerUsername, eventId, eventName, name, message, numbers } = request.body || {};
    if (!organizerId || !eventId || !eventName) {
      return reply.code(400).send({ success: false, error: "Missing required campaign fields" });
    }
    try {
      const campaign = await createSmsCampaign({
        organizerId, organizerEmail, organizerUsername, eventId, eventName, name, message, numbers,
      });
      return reply.code(201).send({ success: true, campaign });
    } catch (err) {
      if (replyForError(err, reply)) return;
      fastify.log.error({ err }, "[sms] failed to create campaign");
      return reply.code(500).send({ success: false, error: "Failed to create bulk SMS" });
    }
  });
}
