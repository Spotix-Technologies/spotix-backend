/**
 * v1/routes/webhooks/ses.js
 *
 * POST /v1/webhooks/ses — Amazon SNS delivers SES notifications here
 * (spec §4). Handles SubscriptionConfirmation (auto-confirms by hitting
 * SubscribeURL) and Notification (the actual SES events).
 *
 * SNS message signature is verified properly (fetches the signing cert
 * from a *.amazonaws.com URL, RSA verify over the canonical string) —
 * this endpoint is public on the internet, so skipping this check would
 * let anyone forge delivery/bounce events and manipulate credit
 * accounting. If CAMPAIGN_SNS_TOPIC_ARN is set, the TopicArn is also
 * checked as defense in depth.
 */

import crypto from "node:crypto";
import { applyDeliveryEvent } from "../../lib/campaigns/webhook-processor.js";

const EVENT_TYPE_MAP = {
  Delivery: "delivered",
  Bounce: "bounced",
  Complaint: "complained",
  Open: "opened",
  Click: "clicked",
  Send: "sent",
  DeliveryDelay: "delayed",
  // Reject / RenderingFailure: no recipient state change here — they
  // precede Send and won't have our tags anyway.
};

// SES reuses the same mail.messageId for every event type it fires on
// that email (Send, Delivery, Open, Click, ...), so a plain
// `${messageId}:${eventType}` dedup key collides across DISTINCT clicks
// on the same email (the CTA link, then the unsubscribe link) or
// multiple opens — the second one would look like a duplicate of the
// first and get silently dropped by insertEmailEvent's unique-index
// guard. Fold in what actually makes each occurrence distinct: which
// link (for clicks) and when.
function buildProviderEventId(sesEvent) {
  const messageId = sesEvent.mail?.messageId;
  if (!messageId) return null;
  if (sesEvent.eventType === "Click") {
    return `${messageId}:Click:${sesEvent.click?.link || ""}:${sesEvent.click?.timestamp || ""}`;
  }
  if (sesEvent.eventType === "Open") {
    return `${messageId}:Open:${sesEvent.open?.timestamp || ""}`;
  }
  return `${messageId}:${sesEvent.eventType}`;
}

// ---------------------------------------------------------------------------
// Signing cert cache — AWS rotates these rarely, so caching avoids a network
// round-trip on every single webhook event.
// ---------------------------------------------------------------------------
const CERT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const certCache = new Map(); // url -> { pem, expiresAt }

async function fetchSigningCert(certUrl) {
  const now = Date.now();
  const cached = certCache.get(certUrl);
  if (cached && cached.expiresAt > now) return cached.pem;

  // No timeout here previously — Node/undici's default connect timeout
  // is 10s, which silently ate every slow/unreachable fetch and turned
  // it into a bare `null` with the real error thrown away (see
  // verifySnsSignature below). Setting our own explicit timeout doesn't
  // change that ceiling, but it lets us label the failure and retry
  // once before giving up, instead of a single silent attempt.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(certUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Failed to fetch signing cert: ${res.status}`);
      const pem = await res.text();
      certCache.set(certUrl, { pem, expiresAt: now + CERT_CACHE_TTL_MS });
      return pem;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// URL validation helpers
// ---------------------------------------------------------------------------
function isAwsSnsHostname(hostname) {
  return /^sns\.[a-zA-Z0-9-]+\.amazonaws\.com$/.test(hostname);
}

function isValidCertUrl(certUrl) {
  try {
    const u = new URL(certUrl);
    return u.protocol === "https:" && isAwsSnsHostname(u.hostname);
  } catch {
    return false;
  }
}

function isValidSubscribeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === "https:" && isAwsSnsHostname(u.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Canonical string + signature verification
// ---------------------------------------------------------------------------
function buildCanonicalString(msg) {
  const fieldsByType = {
    Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
    SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
    UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  };
  const fields = fieldsByType[msg.Type] || fieldsByType.Notification;
  let out = "";
  for (const field of fields) {
    if (msg[field] === undefined) continue;
    out += `${field}\n${msg[field]}\n`;
  }
  return out;
}

// Returns { ok, retryable, reason } instead of a bare boolean — the
// route below needs to tell "we couldn't reach AWS to check" (retryable:
// SNS should try again) apart from "we checked and it's forged"
// (permanent: 401, SNS should stop). Collapsing both into one boolean
// was the actual bug: a transient cert-fetch failure silently became a
// blanket "invalid signature" with no logged reason.
async function verifySnsSignature(msg) {
  if (!isValidCertUrl(msg.SigningCertURL)) {
    return { ok: false, retryable: false, reason: "invalid_signing_cert_url" };
  }

  let cert;
  try {
    cert = await fetchSigningCert(msg.SigningCertURL);
  } catch (err) {
    return { ok: false, retryable: true, reason: `cert_fetch_failed: ${err?.message || err}` };
  }

  const algorithm = msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  const verifier = crypto.createVerify(algorithm);
  verifier.update(buildCanonicalString(msg), "utf8");
  try {
    const valid = verifier.verify(cert, msg.Signature, "base64");
    return { ok: valid, retryable: false, reason: valid ? null : "signature_mismatch" };
  } catch (err) {
    return { ok: false, retryable: false, reason: `verify_threw: ${err?.message || err}` };
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
export default async function sesWebhookRoute(fastify, options) {
  // SNS posts with Content-Type: text/plain; charset=UTF-8, so Fastify's
  // default JSON parser won't touch it. Register a parser scoped to this
  // plugin that turns the raw string body into a parsed object.
  fastify.addContentTypeParser(
    "text/plain",
    { parseAs: "string" },
    (req, body, done) => {
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        err.statusCode = 400;
        done(err, undefined);
      }
    }
  );

  fastify.post("/webhooks/ses", async (request, reply) => {
    const msg = request.body;
    if (!msg || !msg.Type) {
      return reply.code(400).send({ success: false, error: "Malformed SNS message" });
    }

    const verification = await verifySnsSignature(msg).catch((err) => ({
      ok: false,
      retryable: true,
      reason: `verify_threw_unexpectedly: ${err?.message || err}`,
    }));

    if (!verification.ok) {
      fastify.log.error(
        { reason: verification.reason, snsMessageId: msg.MessageId, certUrl: msg.SigningCertURL },
        "[webhooks/ses] SNS signature verification failed"
      );
      if (verification.retryable) {
        // Our side failed to fetch/reach the signing cert — not a proof
        // the signature is forged. 503 tells SNS to retry (it will, on
        // its own backoff schedule) instead of permanently dropping a
        // legitimate delivery/bounce/open event because of a transient
        // network blip on our end.
        return reply.code(503).send({ success: false, error: "Temporarily unable to verify signature" });
      }
      return reply.code(401).send({ success: false, error: "Invalid SNS signature" });
    }

    const expectedTopic = process.env.CAMPAIGN_SNS_TOPIC_ARN;
    if (expectedTopic && msg.TopicArn !== expectedTopic) {
      return reply.code(401).send({ success: false, error: "Unexpected TopicArn" });
    }

    if (msg.Type === "SubscriptionConfirmation") {
      // SSRF guard — only confirm against a known AWS SNS endpoint.
      if (!isValidSubscribeUrl(msg.SubscribeURL)) {
        fastify.log.warn({ subscribeUrl: msg.SubscribeURL }, "[webhooks/ses] rejected invalid SubscribeURL");
        return reply.code(400).send({ success: false, error: "Invalid SubscribeURL" });
      }
      try {
        const res = await fetch(msg.SubscribeURL);
        if (!res.ok) {
          fastify.log.error(
            { status: res.status, url: msg.SubscribeURL },
            "[webhooks/ses] SubscribeURL fetch returned non-2xx"
          );
          return reply.code(502).send({ success: false, error: "Failed to confirm subscription" });
        }
        fastify.log.info("[webhooks/ses] SNS subscription confirmed");
      } catch (err) {
        fastify.log.error({ err }, "[webhooks/ses] failed to confirm SNS subscription");
        return reply.code(502).send({ success: false, error: "Failed to confirm subscription" });
      }
      return reply.send({ success: true });
    }

    if (msg.Type !== "Notification") return reply.send({ success: true, skipped: true });

    let sesEvent;
    try {
      sesEvent = JSON.parse(msg.Message);
    } catch {
      return reply.code(400).send({ success: false, error: "Malformed SES event payload" });
    }

    const eventType = EVENT_TYPE_MAP[sesEvent.eventType];
    const tags = sesEvent.mail?.tags || {};
    const campaignId = tags.campaign_id?.[0];
    const campaignRecipientId = tags.campaign_recipient_id?.[0];

    if (!eventType || !campaignId || !campaignRecipientId) {
      return reply.send({ success: true, skipped: true });
    }

    const recipientEmail =
      sesEvent.bounce?.bouncedRecipients?.[0]?.emailAddress ||
      sesEvent.complaint?.complainedRecipients?.[0]?.emailAddress ||
      sesEvent.mail?.destination?.[0];

    try {
      const result = await applyDeliveryEvent({
        campaignId,
        campaignRecipientId,
        provider: "ses",
        providerEventId: buildProviderEventId(sesEvent),
        eventType,
        payload: { recipientEmail, raw: sesEvent.eventType, linkUrl: sesEvent.click?.link || null },
      });
      return reply.send({ success: true, ...result });
    } catch (err) {
      fastify.log.error({ err }, "[webhooks/ses] failed to process event");
      return reply.code(500).send({ success: false, error: "Failed to process event" });
    }
  });
}