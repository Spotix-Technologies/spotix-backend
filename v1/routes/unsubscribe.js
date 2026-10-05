/**
 * v1/routes/unsubscribe.js
 *
 * GET /v1/unsubscribe?token=... — public, no auth (it's a one-click
 * email link, spec §55). Token is HMAC-signed (see lib/campaigns/
 * unsubscribe.js) so it can't be forged to unsubscribe someone else.
 *
 * The email's actual unsubscribe link now points at spotix-user's own
 * branded /unsubscribe page (createUnsubscribeUrl), not here directly —
 * that page calls POST /v1/unsubscribe (JSON) below to do the real work.
 * This GET route is kept as a plain-HTML fallback: anything (an old
 * List-Unsubscribe client, a mail scanner) that hits the raw backend
 * link directly still unsubscribes correctly without needing the
 * frontend at all.
 */

import { verifyUnsubscribeToken } from "../lib/campaigns/unsubscribe.js";
import { setUnsubscribed } from "../lib/campaigns/repo.js";

function htmlPage(message) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#3d2c5e;">
    <h2>${message}</h2>
  </body></html>`;
}

export default async function unsubscribeRoute(fastify, options) {
  fastify.get("/unsubscribe", async (request, reply) => {
    const token = request.query?.token;
    const parsed = token ? verifyUnsubscribeToken(token) : null;
    if (!parsed) {
      return reply.code(400).type("text/html").send(htmlPage("This unsubscribe link is invalid or expired."));
    }
    try {
      await setUnsubscribed(parsed.organizerId, parsed.email, true);
      return reply.type("text/html").send(htmlPage("You've been unsubscribed from these campaign emails."));
    } catch (err) {
      fastify.log.error({ err }, "[unsubscribe] failed to set unsubscribed");
      return reply.code(500).type("text/html").send(htmlPage("Something went wrong — please try again later."));
    }
  });

  // POST /unsubscribe — JSON, called by spotix-user's /unsubscribe page.
  // Same token verification and same setUnsubscribed() call as the GET
  // route above — this only differs in what it returns, so both entry
  // points stay perfectly consistent with each other by construction.
  fastify.post("/unsubscribe", async (request, reply) => {
    const token = request.body?.token || request.query?.token;
    const parsed = token ? verifyUnsubscribeToken(token) : null;
    if (!parsed) {
      return reply.code(400).send({ success: false, error: "This unsubscribe link is invalid or expired." });
    }
    try {
      await setUnsubscribed(parsed.organizerId, parsed.email, true);
      return reply.send({ success: true, email: parsed.email });
    } catch (err) {
      fastify.log.error({ err }, "[unsubscribe] failed to set unsubscribed");
      return reply.code(500).send({ success: false, error: "Something went wrong — please try again later." });
    }
  });
}
