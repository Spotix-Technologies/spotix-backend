// v1/mcp-oauth-metadata.js
//
// OAuth discovery documents, registered at this backend's ROOT (no /v1
// prefix) because RFC 8414 fixes .well-known paths relative to the
// issuer's origin, not to whatever API prefix the rest of this service
// happens to use. See v1/lib/mcp-oauth/metadata.js for what's actually
// in these documents and why the authorization_endpoint points at
// spotix-booker (a different origin) while everything else stays here.

import { buildAuthorizationServerMetadata, buildProtectedResourceMetadata } from "../lib/mcp-oauth/metadata.js";

export default async function mcpOAuthMetadataRoutes(fastify, options) {
  fastify.get("/.well-known/oauth-authorization-server", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.code(200).send(buildAuthorizationServerMetadata());
  });

  // Fallback copy — spotix-mcp serves its own authoritative version of
  // this document at ITS origin (mcp.spotix.com.ng). Kept here too so
  // tooling that only knows the issuer origin can still resolve it.
  fastify.get("/.well-known/oauth-protected-resource", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.code(200).send(buildProtectedResourceMetadata());
  });
}
