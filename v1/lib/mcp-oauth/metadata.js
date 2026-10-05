// v1/lib/mcp-oauth/metadata.js
//
// Builds the RFC 8414 Authorization Server Metadata document. Served by
// v1/mcp-oauth-metadata.js at GET /.well-known/oauth-authorization-server
// (registered at the ROOT of this backend, not under /v1 — the
// .well-known path is fixed by spec relative to the issuer origin).
//
// spotix-backend is the issuer: it's the one service that actually mints
// and validates tokens (see store.js). The *interactive* authorization
// endpoint intentionally lives on a different origin — spotix-booker,
// since that's where the booker's login session and the consent UI
// already live — which RFC 8414 permits; nothing requires every endpoint
// in this document to share an origin with the issuer, only that the
// document itself is retrievable at `{issuer}/.well-known/...`, which it
// is (see mcp-oauth-metadata.js).

import { SUPPORTED_SCOPES } from "./scopes.js";

function trimSlash(url) {
  return (url || "").replace(/\/+$/, "");
}

function backendIssuer() {
  // APP_URL is this backend's own public base URL — already used
  // elsewhere in this codebase (v1/lib/mcp/orders.js) as the canonical
  // "where am I" value.
  return trimSlash(process.env.BACKEND_URL || "https://api.spotix.com.ng");
}

function bookerUrl() {
  return trimSlash(process.env.BOOKER_PUBLIC_URL || "https://booker.spotix.com.ng");
}

export function buildAuthorizationServerMetadata() {
  const issuer = backendIssuer();
  return {
    issuer,
    authorization_endpoint: `${bookerUrl()}/mcp/authorize`,
    token_endpoint: `${issuer}/v1/mcp/oauth/token`,
    registration_endpoint: `${issuer}/v1/mcp/oauth/register`,
    revocation_endpoint: `${issuer}/v1/mcp/oauth/revoke`,
    userinfo_endpoint: `${issuer}/v1/mcp/oauth/userinfo`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // "none" = public client (PKCE-only, no client_secret) — the expected
    // case for AI chat clients. client_secret_post stays available for a
    // confidential client that registers with one.
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    service_documentation: "https://github.com/spotix/spotix-mcp#authentication",
    op_policy_uri: `https://legal.spotix.com.ng/`,
    op_tos_uri: `https://legal.spotix.com.ng/`,
  };
}

/**
 * RFC 9728 Protected Resource Metadata. Strictly speaking this belongs
 * to the resource server (spotix-mcp), which serves its own copy at its
 * own origin — see spotix-mcp's src/lib/oauth-metadata.ts. This backend
 * copy exists only as a convenience/fallback for tooling that resolves
 * it from the AS side instead; the two must stay in agreement on
 * `authorization_servers`.
 */
export function buildProtectedResourceMetadata() {
  const mcpUrl = trimSlash(process.env.SPOTIX_MCP_RESOURCE_URL || "https://mcp.spotix.com.ng");
  return {
    resource: mcpUrl,
    authorization_servers: [backendIssuer()],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/spotix/spotix-mcp#authentication",
  };
}
