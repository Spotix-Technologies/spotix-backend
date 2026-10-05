// v1/lib/mcp-oauth/pkce.js
//
// RFC 7636 (PKCE) verification. The MCP Authorization spec mandates PKCE
// with S256 for every client — public clients (no client_secret, which
// covers essentially every AI chat client connecting to this server)
// have no other way to prove the /token request came from the same
// party that started the /authorize request, so this is not optional
// here the way it might be for a confidential-client-only AS.

import { createHash } from "crypto";

export const REQUIRED_METHOD = "S256";

/** Base64url-encode (no padding) per RFC 7636 §4.2. */
function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * True if `verifier` (from the /token request) hashes to `challenge`
 * (stored against the authorization code at /authorize time).
 * Only S256 is accepted — "plain" is rejected at /authorize already
 * (see v1/mcp-oauth.js), so this should never see anything else, but
 * the check stays explicit rather than assumed.
 */
export function verifyCodeChallenge(verifier, challenge, method) {
  if (method !== REQUIRED_METHOD) return false;
  if (!verifier || typeof verifier !== "string") return false;
  // RFC 7636 §4.1 — 43-128 chars, unreserved URI characters only.
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;

  const computed = base64url(createHash("sha256").update(verifier).digest());
  return computed === challenge;
}

/** True if a code_challenge value looks like a well-formed S256 challenge. */
export function isValidCodeChallenge(challenge) {
  return typeof challenge === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(challenge);
}
