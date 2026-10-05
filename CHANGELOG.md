# Changelog — spotix-backend

All notable changes to this service are documented here. Dates are UTC.

## [Unreleased] — MCP OAuth & booker-management routes (supports spotix-mcp v1.0.1b)

### Added
- **MCP OAuth 2.1 authorization server** (`v1/mcp-oauth.js`, `v1/lib/mcp-oauth/*`)
  - `POST /v1/mcp/oauth/register` — Dynamic Client Registration (RFC 7591)
  - `POST /v1/mcp/oauth/authorize` — internal; finalizes an authorization code after spotix-booker's `/mcp/authorize` page collects login + consent
  - `POST /v1/mcp/oauth/token` — `authorization_code` (PKCE, S256-only) and `refresh_token` grants
  - `POST /v1/mcp/oauth/revoke` — RFC 7009 token revocation
  - `GET /v1/mcp/oauth/userinfo` — resolves a Bearer token to a public-safe identity
  - `GET /v1/mcp/oauth/clients/:clientId` — public client metadata (name/logo) for the consent screen
  - `GET /v1/mcp/oauth/connections`, `DELETE /v1/mcp/oauth/connections/:clientId` — internal; backs the booker's "Connected Apps" list/revoke UI
  - `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource` (`v1/mcp-oauth-metadata.js`, registered at the app root, not under `/v1`, since `.well-known` paths are fixed relative to the issuer origin)
  - New Firestore collections: `mcpClients`, `mcpAuthCodes`, `mcpAccessTokens`, `mcpRefreshTokens`, `mcpConnections`. This service is the sole writer of all five.
- **Authenticated booker-management routes** (`v1/mcp-booker.js`, `v1/lib/mcp/booker-events.js`), all Bearer-token gated and strictly ownership-checked (`organizerId === uid`, no collaborator parity path):
  - `GET /v1/mcp/booker/my-events` (+ `?eventId=`) — list/verify-ownership
  - `GET /v1/mcp/booker/my-events/:eventId/stats` — tickets sold, per-type breakdown, revenue, paid out, available to pay out
  - `GET|POST /v1/mcp/booker/my-events/:eventId/discounts`, `PATCH .../discounts/deactivate`
  - `GET|POST /v1/mcp/booker/my-events/:eventId/referrals`
  - `GET|POST /v1/mcp/booker/my-events/:eventId/share` — slugged event link; creates a slug on request if the event doesn't have one yet
- `v1/lib/mcp/slug.js` — plain-JS port of spotix-booker's `app/lib/slug.ts`, kept deliberately in sync so an MCP-created link follows identical rules to one made by hand.

### Environment
New variables (see updated deployment docs):
- `BOOKER_PUBLIC_URL` — spotix-booker's public origin, used to build `authorization_endpoint` in the AS metadata document. Defaults to `https://booker.spotix.com.ng`.
- `SPOTIX_MCP_RESOURCE_URL` — the MCP resource identifier, used in the (fallback) protected-resource metadata document. Defaults to `https://mcp.spotix.com.ng`.
- `MCP_OAUTH_INTERNAL_SECRET` — **required**, no default. Shared secret between this service and spotix-booker's `app/api/mcp/authorize` and `app/api/mcp/connections` routes. Deliberately separate from `CRON_SECRET`/other internal secrets — see `v1/mcp-oauth.js` for the reasoning.

### Notes
- No new npm dependencies. Tokens are opaque, sha256-hashed random strings — the same pattern spotix-booker's own `spk_live_...` SDK API keys already use — and the OAuth token endpoint's `application/x-www-form-urlencoded` body is parsed with a small custom Fastify content-type parser built on `URLSearchParams`, not a new package.
- The 4 existing anonymous tools' routes (`v1/mcp.js`) are untouched by this change.
