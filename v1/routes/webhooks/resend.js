/**
 * v1/routes/webhooks/resend.js
 *
 * POST /v1/webhooks/resend
 *
 * Resend signs webhooks the svix way (svix-id/svix-timestamp/svix-signature
 * headers, HMAC-SHA256 over "id.timestamp.rawBody"). The signature MUST be
 * computed over the exact raw bytes Resend sent, NOT over a re-serialized
 * `JSON.stringify(request.body)` — re-serialization is not byte-stable
 * (whitespace, key order, unicode escapes, number formatting can all
 * change), which silently breaks verification for a subset of payloads.
 *
 * To get those exact bytes we register a content-type parser for
 * "application/json" scoped to this plugin (mirrors the text/plain parser
 * ses.js registers for the same reason) that stashes the raw buffer on
 * `request.rawBody` before handing the parsed JSON to Fastify as usual.
 * Registering it inside this plugin function keeps it encapsulated to
 * just the /webhooks/resend route — it does not touch the default JSON
 * parsing used by every other route.
 *
 * Recipient lookup uses the campaign_id/campaign_recipient_id TAGS set
 * at send time (delivery/resend-provider.js), not a DB search.
 */

import crypto from "node:crypto";
import { applyDeliveryEvent } from "../../lib/campaigns/webhook-processor.js";

const EVENT_TYPE_MAP = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.delivery_delayed": "delayed",
};

// Same dedup issue as ses.js's buildProviderEventId: Resend's email_id
// is stable across every event fired for that email, so a bare
// `${email_id}:${type}` key collides across distinct clicks (CTA link
// vs. unsubscribe link) or repeat opens. Fold in what makes each
// occurrence distinct.
function buildProviderEventId(type, data) {
  const emailId = data?.email_id;
  if (!emailId) return null;
  if (type === "email.clicked") {
    return `${emailId}:clicked:${data?.click?.link || ""}:${data?.click?.timestamp || ""}`;
  }
  if (type === "email.opened") {
    return `${emailId}:opened:${data?.open?.timestamp || data?.created_at || ""}`;
  }
  return `${emailId}:${type}`;
}

// Reject webhooks whose timestamp is older than this. Svix recommends
// 5 minutes; it bounds the replay window without being so tight that
// clock skew or network latency causes spurious 401s.
const SVIX_TIMESTAMP_TOLERANCE_SEC = 5 * 60;

function verifySvixSignature(request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;

  const svixId = request.headers["svix-id"];
  const svixTimestamp = request.headers["svix-timestamp"];
  const svixSignature = request.headers["svix-signature"];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Replay protection — reject anything outside the tolerance window.
  const ts = Number.parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > SVIX_TIMESTAMP_TOLERANCE_SEC) return false;

  // The scoped content-type parser above stashes the exact bytes Resend
  // hashed on request.rawBody. Fall back to false if it's missing for any
  // reason rather than silently re-serializing and producing a false
  // positive.
  const rawBody = request.rawBody;
  if (!rawBody || rawBody.length === 0) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");

  // Concatenate as buffers, not strings — String(bytes) would re-encode
  // multi-byte UTF-8 and change the byte sequence.
  const signedContent = Buffer.concat([
    Buffer.from(`${svixId}.${svixTimestamp}.`, "utf8"),
    rawBody,
  ]);

  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  // Header format: "v1,<base64> v1,<base64> ..." (space-separated list of
  // version-prefixed signatures). Filter to v1 so we don't accidentally
  // compare a v2 signature against a v1 digest.
  const expectedBuf = Buffer.from(expected);
  return svixSignature
    .split(" ")
    .map((part) => part.split(","))
    .filter(([version]) => version === "v1")
    .map(([, sig]) => sig)
    .filter(Boolean)
    .some((sig) => {
      const providedBuf = Buffer.from(sig);
      return (
        providedBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(providedBuf, expectedBuf)
      );
    });
}

export default async function resendWebhookRoute(fastify, options) {
  // Capture the exact raw bytes before JSON-parsing so the signature check
  // above can hash the same bytes Resend signed. `request.body` still comes
  // out parsed as normal — this only adds `request.rawBody` alongside it.
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      req.rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body) : {});
      } catch (err) {
        err.statusCode = 400;
        done(err, undefined);
      }
    }
  );

  fastify.post(
    "/webhooks/resend",
    async (request, reply) => {
      if (!verifySvixSignature(request)) {
        return reply.code(401).send({ success: false, error: "Invalid signature" });
      }

      const { type, data } = request.body || {};
      const eventType = EVENT_TYPE_MAP[type];
      // Resend's actual webhook payload sends tags as a plain
      // { campaign_id: "...", campaign_recipient_id: "..." } object, not
      // the [{ name, value }] array shape their docs describe elsewhere —
      // handle both so a future/older payload shape doesn't 500 either.
      const rawTags = data?.tags;
      const tags = Array.isArray(rawTags)
        ? Object.fromEntries(rawTags.filter((t) => t?.name).map((t) => [t.name, t.value]))
        : rawTags && typeof rawTags === "object"
          ? rawTags
          : {};
      const campaignId = tags.campaign_id;
      const campaignRecipientId = tags.campaign_recipient_id;

      if (!eventType || !campaignId || !campaignRecipientId) {
        // Not an event we track, or missing our tags (e.g. a non-campaign
        // Resend email) — acknowledge and skip, don't error the webhook.
        return reply.send({ success: true, skipped: true });
      }

      try {
        const result = await applyDeliveryEvent({
          campaignId,
          campaignRecipientId,
          provider: "resend",
          providerEventId: buildProviderEventId(type, data),
          eventType,
          payload: { recipientEmail: data?.to?.[0], raw: type, linkUrl: data?.click?.link || null },
        });
        return reply.send({ success: true, ...result });
      } catch (err) {
        fastify.log.error({ err }, "[webhooks/resend] failed to process event");
        return reply.code(500).send({ success: false, error: "Failed to process event" });
      }
    }
  );
}