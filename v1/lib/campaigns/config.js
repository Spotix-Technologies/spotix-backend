/**
 * v1/lib/campaigns/config.js
 *
 * Feature-flag reading for the Campaigns system (spec §2). The flags are
 * intentionally numeric strings — "1" means on, EVERYTHING else (missing,
 * "true", "yes", "0", ...) means off. Never loosen this comparison.
 */

function isOn(envVar) {
  return process.env[envVar] === "1";
}

export function isCampaignEnabled() {
  return isOn("isCampaignOn");
}

/**
 * Gates the AI moderation layer (v1/lib/campaigns/moderation). "1" means
 * every campaign start is checked (wordlist, then Gemini) before it's
 * allowed to queue — the booker sees "Our system is reviewing the
 * campaign" while that happens. Missing or "0" means campaigns start
 * sending instantly, exactly as before this feature existed.
 */
export function isValidationAllowed() {
  return isOn("isValidationAllowed");
}

/**
 * Resolves which provider a campaign should use right now.
 *   - both off  → null (campaign waits, spec §31)
 *   - SES on    → "ses" (SES always wins when both are on, spec §2 Case 4)
 *   - Resend on → "resend"
 */
export function resolveDeliveryProvider() {
  const sesOn = isOn("isSESActive");
  const resendOn = isOn("isResendActive");
  if (sesOn) return "ses";
  if (resendOn) return "resend";
  return null;
}
