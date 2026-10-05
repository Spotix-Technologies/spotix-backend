// v1/lib/mcp-oauth/scopes.js
//
// Scope registry for the MCP OAuth authorization server. One scope today
// (`booker`) — everything the authenticated tools in v1/mcp-booker.js do
// (read events/stats, create/deactivate discounts, create referrals,
// share links) is granted or denied as a single unit, matching the single
// consent screen spotix-booker's /mcp/authorize page shows ("view and
// make changes on their Spotix account"). A future narrower scope (e.g.
// read-only) is a registry addition here plus a check in
// v1/lib/mcp-oauth/store.js's verifyAccessToken callers — nothing about
// the token format needs to change.

export const SUPPORTED_SCOPES = ["booker"];

export const DEFAULT_SCOPE = "booker";

export const SCOPE_DESCRIPTIONS = {
  booker:
    "View your events, ticket sales and payout figures, and create or manage discount codes, referral codes, and shareable event links on your behalf.",
};

/**
 * Normalises a requested scope string (space-delimited, RFC 6749 §3.3)
 * down to the subset this AS actually supports. Never throws — callers
 * that require at least one valid scope check the returned array's
 * length themselves (this lets "invalid_scope" vs "no scope requested,
 * default applied" be distinguished by the caller).
 */
export function resolveRequestedScopes(rawScope) {
  if (!rawScope || typeof rawScope !== "string") return [DEFAULT_SCOPE];
  const requested = rawScope.split(/\s+/).filter(Boolean);
  const valid = requested.filter((s) => SUPPORTED_SCOPES.includes(s));
  return valid.length > 0 ? valid : [DEFAULT_SCOPE];
}

export function describeScopes(scopes) {
  return scopes.map((s) => SCOPE_DESCRIPTIONS[s] || s);
}
