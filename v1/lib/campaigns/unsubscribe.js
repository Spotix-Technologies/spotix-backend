/**
 * v1/lib/campaigns/unsubscribe.js
 *
 * One-click unsubscribe links (spec §55) need a token that's verifiable
 * without a login, but that can't be forged to unsubscribe someone else's
 * contact. HMAC-SHA256 over `${organizerId}:${email}`, signed with
 * CAMPAIGN_UNSUBSCRIBE_SECRET — no new dependency, matches the
 * "reuse existing patterns" instruction better than pulling in a JWT
 * lib the backend doesn't otherwise use.
 */

import crypto from "node:crypto";

const SECRET = process.env.CAMPAIGN_UNSUBSCRIBE_SECRET || process.env.CRON_SECRET || "";

function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

export function createUnsubscribeToken(organizerId, email) {
  const payload = `${organizerId}:${email}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export function createUnsubscribeUrl(organizerId, email) {
  // Points at spotix-user's own branded /unsubscribe page (not this
  // backend's bare HTML fallback below), which calls POST /v1/unsubscribe
  // itself to actually process the token. Same env var email-render.js
  // already uses for the event/ticket link, so both point at wherever
  // spotix-user is actually deployed — falls back to the literal
  // spotix.com.ng apex domain if unset.
  const base = process.env.NEXT_PUBLIC_SPOTIX_USER || "https://spotix.com.ng";
  const token = createUnsubscribeToken(organizerId, email);
  return `${base}/unsubscribe?token=${token}`;
}

/** Returns { organizerId, email } if the token is valid, else null. */
export function verifyUnsubscribeToken(token) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    const sig = parts.pop();
    const payload = parts.join(":");
    const [organizerId, email] = payload.split(":");
    if (!organizerId || !email) return null;
    const expected = sign(payload);
    const a = Buffer.from(sig || "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { organizerId, email };
  } catch {
    return null;
  }
}
