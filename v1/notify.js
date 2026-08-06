/**
 * v1/notify.js
 *
 * Registered in server.js as: fastify.register(notifyRoutes, { prefix: "/v1/notify" })
 *
 * This file no longer defines any routes itself — every route previously
 * defined here has been split out into its own file under v1/mail-routes/,
 * one route per file, all sharing the single Mailjet client in
 * v1/mail-routes/_mailjet-client.js. notify.js just registers them.
 *
 * Registering a sub-plugin without a `prefix` option keeps its route paths
 * exactly as declared (e.g. "/team-member-added"), so the final URLs are
 * unchanged: /v1/notify/team-member-added, /v1/notify/agent-onboard, etc.
 *
 * Endpoints (all POST):
 *   /v1/notify/team-member-added
 *   /v1/notify/agent-onboard
 *   /v1/notify/agent-ticket
 *   /v1/notify/agent-sale
 *   /v1/notify/refund-request
 *   /v1/notify/vault-notify   ← new: Vault payout sign-off notification
 */

import teamMemberAddedRoute from "./mail-routes/team-member-added.js"
import agentOnboardRoute from "./mail-routes/agent-onboard.js"
import agentTicketRoute from "./mail-routes/agent-ticket.js"
import agentSaleRoute from "./mail-routes/agent-sale.js"
import refundRequestRoute from "./mail-routes/refund-request.js"
import vaultNotifyRoute from "./mail-routes/vault-notify.js"

export default async function notifyRoutes(fastify, options) {
  await fastify.register(teamMemberAddedRoute)
  await fastify.register(agentOnboardRoute)
  await fastify.register(agentTicketRoute)
  await fastify.register(agentSaleRoute)
  await fastify.register(refundRequestRoute)
  await fastify.register(vaultNotifyRoute)
}
