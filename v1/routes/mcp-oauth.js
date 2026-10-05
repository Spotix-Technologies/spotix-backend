// v1/mcp-oauth.js
//
// The MCP OAuth 2.1 authorization server's protocol endpoints. This file
// is the ONLY place that writes to the mcpClients/mcpAuthCodes/
// mcpAccessTokens/mcpRefreshTokens/mcpConnections Firestore collections
// (see v1/lib/mcp-oauth/store.js) — same single-writer principle
// v1/lib/mcp/ already applies to pricing/inventory.
//
// Split by who calls each route:
//
//   Public (called directly by the AI chat client / its host app):
//     POST /register    — Dynamic Client Registration (RFC 7591)
//     POST /token        — authorization_code + refresh_token grants (RFC 6749)
//     POST /revoke        — token revocation (RFC 7009)
//     GET  /userinfo       — resolves a Bearer token to a public-safe identity
//     GET  /clients/:id     — public client metadata (name/logo), so
//                              spotix-booker's /mcp/authorize page can
//                              render "X wants to connect" without needing
//                              its own Firestore access for this collection
//
//   Internal only (called server-to-server by spotix-booker's own API
//   routes AFTER it has verified the booker's own session — see
//   spotix-booker's app/api/mcp/authorize/route.ts and
//   app/api/mcp/connections/route.ts). Guarded by a dedicated shared
//   secret (x-mcp-internal-secret / MCP_OAUTH_INTERNAL_SECRET) — kept
//   separate from CRON_SECRET so a leak of one never grants the other's
//   blast radius (defense in depth, same reasoning as having a distinct
//   secret per internal integration rather than one secret for all of them):
//     POST   /authorize            — mint an authorization code for a
//                                     just-consented booker
//     GET    /connections           — list a booker's connected apps
//     DELETE /connections/:clientId — revoke one

import {
  registerClient,
  getClient,
  isRegisteredRedirectUri,
  clientRequiresSecret,
  verifyClientSecret,
  REDIRECT_URI_LIMIT,
  createAuthorizationCode,
  redeemAuthorizationCode,
  issueTokenPair,
  verifyAccessToken,
  consumeRefreshToken,
  listConnectionsForUser,
  revokeConnection,
  revokeToken,
} from "../lib/mcp-oauth/store.js";
import { McpOAuthError } from "../lib/mcp-oauth/errors.js";
import { verifyCodeChallenge, isValidCodeChallenge, REQUIRED_METHOD } from "../lib/mcp-oauth/pkce.js";
import { resolveRequestedScopes } from "../lib/mcp-oauth/scopes.js";

const DEV_TAG = "API developed and maintained by Spotix Technologies";

function ok(reply, data, status = 200) {
  return reply.code(status).send({ success: true, developer: DEV_TAG, ...data });
}

function sendOAuthError(reply, err) {
  const shaped = err instanceof McpOAuthError ? err : new McpOAuthError("server_error", "Unexpected error");
  return reply.code(shaped.statusCode).send(shaped.toBody());
}

function requireInternalMcpSecret(request, reply) {
  const secret = request.headers["x-mcp-internal-secret"];
  if (!secret || secret !== process.env.MCP_OAUTH_INTERNAL_SECRET) {
    reply.code(401).send({ success: false, error: "Unauthorized", developer: DEV_TAG });
    return true;
  }
  return false;
}

function isHttpsOrLoopback(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol === "https:") return true;
    // Loopback exception (RFC 8252 §7.3) — lets a local/dev MCP client
    // (e.g. a developer testing with the modelcontextprotocol Inspector
    // on localhost) register without needing a public HTTPS endpoint.
    return (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.protocol === "http:";
  } catch {
    return false;
  }
}

export default async function mcpOAuthRoutes(fastify, options) {
  // OAuth's token endpoint is required to accept
  // application/x-www-form-urlencoded (RFC 6749 §4.1.3) — Fastify only
  // parses JSON out of the box, so this adds urlencoded support using
  // just the built-in URLSearchParams (no new dependency). JSON bodies
  // are still accepted too (Fastify's default parser), for clients that
  // send this endpoint JSON instead — pragmatic, not spec-mandated.
  fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body)));
    } catch (err) {
      done(err);
    }
  });

  // ── POST /register — Dynamic Client Registration (RFC 7591) ──────────────
  // Wire format is snake_case per spec. Public clients (the expected case
  // for AI chat hosts) omit token_endpoint_auth_method or send "none" —
  // no client_secret is issued; PKCE is what actually authenticates the
  // /token call for those. "client_secret_post" issues a secret, shown
  // exactly once in this response.
  fastify.post("/register", async (request, reply) => {
    const body = request.body || {};
    const clientName = String(body.client_name ?? "").trim();
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];

    if (!clientName) {
      return sendOAuthError(reply, new McpOAuthError("invalid_client_metadata", "client_name is required", 400));
    }
    if (redirectUris.length === 0 || redirectUris.length > REDIRECT_URI_LIMIT) {
      return sendOAuthError(
        reply,
        new McpOAuthError("invalid_redirect_uri", `Provide between 1 and ${REDIRECT_URI_LIMIT} redirect_uris`, 400)
      );
    }
    if (!redirectUris.every(isHttpsOrLoopback)) {
      return sendOAuthError(reply, new McpOAuthError("invalid_redirect_uri", "Every redirect_uri must be https:// (or http://localhost for local development)", 400));
    }

    const authMethod = body.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none";

    try {
      const client = await registerClient({
        clientName,
        redirectUris,
        logoUri: typeof body.logo_uri === "string" ? body.logo_uri : null,
        clientUri: typeof body.client_uri === "string" ? body.client_uri : null,
        tokenEndpointAuthMethod: authMethod,
        softwareId: typeof body.software_id === "string" ? body.software_id : null,
        softwareVersion: typeof body.software_version === "string" ? body.software_version : null,
      });

      return reply.code(201).send({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        logo_uri: client.logoUri,
        client_uri: client.clientUri,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    } catch (err) {
      fastify.log.error({ err }, "[mcp-oauth] register failed");
      return sendOAuthError(reply, new McpOAuthError("server_error", "Could not register this client"));
    }
  });

  // ── GET /clients/:clientId — public metadata for the consent screen ──────
  fastify.get("/clients/:clientId", async (request, reply) => {
    const client = await getClient(request.params.clientId);
    if (!client) return reply.code(404).send({ success: false, error: "Unknown client", developer: DEV_TAG });
    return ok(reply, {
      client: {
        clientId: client.clientId,
        clientName: client.clientName || "A custom MCP client",
        logoUri: client.logoUri || null,
        clientUri: client.clientUri || null,
      },
    });
  });

  // ── POST /authorize — internal, called by spotix-booker after login+consent
  // Body: { uid, email, username, clientId, redirectUri, scope, codeChallenge,
  //         codeChallengeMethod, state }
  // Returns: { redirectUrl } — booker does the actual browser redirect.
  fastify.post("/authorize", async (request, reply) => {
    if (requireInternalMcpSecret(request, reply)) return;

    const { uid, email, username, clientId, redirectUri, scope, codeChallenge, codeChallengeMethod, state } = request.body || {};

    if (!uid) return sendOAuthError(reply, new McpOAuthError("invalid_request", "uid is required", 400));

    try {
      const client = await getClient(clientId);
      if (!client) return sendOAuthError(reply, new McpOAuthError("invalid_client", "Unknown client_id"));
      if (!isRegisteredRedirectUri(client, redirectUri)) {
        return sendOAuthError(reply, new McpOAuthError("invalid_request", "redirect_uri does not match any URI this client registered"));
      }
      if (codeChallengeMethod !== REQUIRED_METHOD || !isValidCodeChallenge(codeChallenge)) {
        return sendOAuthError(reply, new McpOAuthError("invalid_request", "A valid S256 code_challenge is required"));
      }

      const scopes = resolveRequestedScopes(scope);

      const code = await createAuthorizationCode({
        clientId,
        uid,
        email: email ?? null,
        username: username ?? null,
        redirectUri,
        scope: scopes.join(" "),
        codeChallenge,
        codeChallengeMethod,
      });

      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set("code", code);
      if (state) redirectUrl.searchParams.set("state", state);

      return ok(reply, { redirectUrl: redirectUrl.toString() });
    } catch (err) {
      fastify.log.error({ err }, "[mcp-oauth] authorize failed");
      return sendOAuthError(reply, new McpOAuthError("server_error", "Could not complete authorization"));
    }
  });

  // ── POST /token — authorization_code and refresh_token grants ────────────
  fastify.post("/token", async (request, reply) => {
    const body = request.body || {};
    const grantType = body.grant_type;

    try {
      if (grantType === "authorization_code") {
        const { code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: clientId, client_secret: clientSecret } = body;
        if (!code || !redirectUri || !codeVerifier || !clientId) {
          return sendOAuthError(reply, new McpOAuthError("invalid_request", "code, redirect_uri, code_verifier, and client_id are required"));
        }

        const client = await getClient(clientId);
        if (!client) return sendOAuthError(reply, new McpOAuthError("invalid_client", "Unknown client_id"));
        if (clientRequiresSecret(client) && !verifyClientSecret(client, clientSecret)) {
          return sendOAuthError(reply, new McpOAuthError("invalid_client", "Invalid client_secret"));
        }

        const record = await redeemAuthorizationCode(code);
        if (!record) return sendOAuthError(reply, new McpOAuthError("invalid_grant", "Authorization code is invalid or expired"));
        if (record.__reused) {
          fastify.log.warn({ clientId: record.clientId, uid: record.uid }, "[mcp-oauth] authorization code reuse detected — revoking connection");
          await revokeConnection(record.uid, record.clientId).catch(() => {});
          return sendOAuthError(reply, new McpOAuthError("invalid_grant", "This authorization code has already been used"));
        }
        if (record.clientId !== clientId) return sendOAuthError(reply, new McpOAuthError("invalid_grant", "client_id does not match this code"));
        if (record.redirectUri !== redirectUri) return sendOAuthError(reply, new McpOAuthError("invalid_grant", "redirect_uri does not match this code"));
        if (!verifyCodeChallenge(codeVerifier, record.codeChallenge, record.codeChallengeMethod)) {
          return sendOAuthError(reply, new McpOAuthError("invalid_grant", "code_verifier does not match"));
        }

        const tokens = await issueTokenPair({
          clientId,
          clientName: client.clientName,
          uid: record.uid,
          email: record.email,
          username: record.username,
          scope: record.scope,
        });

        return reply.code(200).send({
          access_token: tokens.accessToken,
          token_type: "Bearer",
          expires_in: tokens.expiresIn,
          refresh_token: tokens.refreshToken,
          scope: tokens.scope,
        });
      }

      if (grantType === "refresh_token") {
        const { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret } = body;
        if (!refreshToken || !clientId) {
          return sendOAuthError(reply, new McpOAuthError("invalid_request", "refresh_token and client_id are required"));
        }

        const client = await getClient(clientId);
        if (!client) return sendOAuthError(reply, new McpOAuthError("invalid_client", "Unknown client_id"));
        if (clientRequiresSecret(client) && !verifyClientSecret(client, clientSecret)) {
          return sendOAuthError(reply, new McpOAuthError("invalid_client", "Invalid client_secret"));
        }

        const record = await consumeRefreshToken(refreshToken);
        if (!record) return sendOAuthError(reply, new McpOAuthError("invalid_grant", "Refresh token is invalid, expired, or already used"));
        if (record.__reused) {
          return sendOAuthError(reply, new McpOAuthError("invalid_grant", "This refresh token has already been used — the connection has been revoked as a precaution"));
        }
        if (record.clientId !== clientId) return sendOAuthError(reply, new McpOAuthError("invalid_grant", "client_id does not match this refresh token"));

        const tokens = await issueTokenPair({
          clientId,
          clientName: client.clientName,
          uid: record.uid,
          email: record.email,
          username: record.username,
          scope: record.scope,
        });

        return reply.code(200).send({
          access_token: tokens.accessToken,
          token_type: "Bearer",
          expires_in: tokens.expiresIn,
          refresh_token: tokens.refreshToken,
          scope: tokens.scope,
        });
      }

      return sendOAuthError(reply, new McpOAuthError("unsupported_grant_type", `grant_type must be "authorization_code" or "refresh_token"`));
    } catch (err) {
      fastify.log.error({ err }, "[mcp-oauth] token endpoint failed");
      return sendOAuthError(reply, new McpOAuthError("server_error", "Could not issue a token"));
    }
  });

  // ── POST /revoke — RFC 7009 ───────────────────────────────────────────────
  fastify.post("/revoke", async (request, reply) => {
    const { token } = request.body || {};
    if (!token) return sendOAuthError(reply, new McpOAuthError("invalid_request", "token is required"));
    try {
      await revokeToken(token);
    } catch (err) {
      fastify.log.error({ err }, "[mcp-oauth] revoke failed");
    }
    // RFC 7009 §2.2 — always 200, even if the token was never found
    // (never reveal whether an unknown token existed).
    return reply.code(200).send({});
  });

  // ── GET /userinfo — resolves a Bearer token to a public-safe identity ────
  fastify.get("/userinfo", async (request, reply) => {
    const header = request.headers["authorization"];
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) {
      return reply.code(401).header("WWW-Authenticate", 'Bearer realm="spotix-mcp"').send({ error: "invalid_token" });
    }
    const identity = await verifyAccessToken(token);
    if (!identity) {
      return reply.code(401).header("WWW-Authenticate", 'Bearer realm="spotix-mcp", error="invalid_token"').send({ error: "invalid_token" });
    }
    return reply.code(200).send({ sub: identity.uid, email: identity.email, preferred_username: identity.username, scope: identity.scope });
  });

  // ── GET /connections & DELETE /connections/:clientId — internal, called
  // by spotix-booker's Connected Apps UI on the booker's behalf ────────────
  fastify.get("/connections", async (request, reply) => {
    if (requireInternalMcpSecret(request, reply)) return;
    const { uid } = request.query;
    if (!uid) return reply.code(400).send({ success: false, error: "uid is required", developer: DEV_TAG });
    try {
      const connections = await listConnectionsForUser(uid);
      return ok(reply, { connections });
    } catch (err) {
      fastify.log.error({ err }, "[mcp-oauth] list connections failed");
      return reply.code(500).send({ success: false, error: "Failed to list connections", developer: DEV_TAG });
    }
  });

  fastify.delete("/connections/:clientId", async (request, reply) => {
    if (requireInternalMcpSecret(request, reply)) return;
    const { uid } = request.query;
    const { clientId } = request.params;
    if (!uid) return reply.code(400).send({ success: false, error: "uid is required", developer: DEV_TAG });
    try {
      await revokeConnection(uid, clientId);
      return ok(reply, { message: "Connection revoked" });
    } catch (err) {
      fastify.log.error({ err }, "[mcp-oauth] revoke connection failed");
      return reply.code(500).send({ success: false, error: "Failed to revoke connection", developer: DEV_TAG });
    }
  });
}
