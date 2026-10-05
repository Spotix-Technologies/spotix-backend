// v1/lib/mcp-oauth/auth.js
//
// Bearer-token guard for v1/mcp-booker.js's authenticated routes.
// Mirrors v1/lib/internal-auth.js's requireInternalSecret shape (call it,
// check the boolean, return early if true) but resolves a real per-booker
// identity instead of a single shared secret.

import { verifyAccessToken } from "./store.js";

const DEV_TAG = "API developed and maintained by Spotix Technologies";

/**
 * On success, sets `request.mcpAuth = { uid, email, username, clientId, scope }`
 * and returns false. On failure, sends a spec-shaped 401 (RFC 6750 §3 —
 * WWW-Authenticate header, so a compliant MCP client knows to
 * (re)authenticate) and returns true — callers follow the same
 * `if (await requireMcpAuth(...)) return;` pattern as requireInternalSecret.
 */
export async function requireMcpAuth(request, reply) {
  const header = request.headers["authorization"];
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (!token) {
    reply
      .code(401)
      .header("WWW-Authenticate", 'Bearer realm="spotix-mcp", error="invalid_request"')
      .send({ error: "Unauthorized", message: "A Bearer access token is required for this tool.", developer: DEV_TAG });
    return true;
  }

  const identity = await verifyAccessToken(token);
  if (!identity) {
    reply
      .code(401)
      .header("WWW-Authenticate", 'Bearer realm="spotix-mcp", error="invalid_token"')
      .send({
        error: "Unauthorized",
        message: "This connection is no longer valid — please reconnect your Spotix Booker account.",
        developer: DEV_TAG,
      });
    return true;
  }

  request.mcpAuth = identity;
  return false;
}
