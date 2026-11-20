/**
 * v1/routes/edit-history.js
 *
 * Internal, service-to-service only — same x-internal-secret convention as
 * v1/routes/campaigns.js. spotix-booker (and spotix-admin) authenticate the
 * user and resolve their access to the event FIRST, then call these with an
 * already-trusted actor/eventId. The browser never reaches this backend for
 * edit history.
 *
 *   POST /v1/edit-history   record one edit (204-style fast ack, 201 on write, 200 when nothing changed)
 *   GET  /v1/edit-history   ?eventId=&limit=&before=   newest-first page
 */

import { requireInternalSecret } from "../middleware/internal-auth.js";
import { recordEditHistory, listEditHistory, EditHistoryValidationError } from "../lib/edit-history/repo.js";

export default async function editHistoryRoute(fastify) {
  fastify.addHook("preHandler", (request, reply, done) => {
    if (requireInternalSecret(request, reply)) return; // already replied 401
    done();
  });

  fastify.post("/edit-history", async (request, reply) => {
    try {
      const row = await recordEditHistory(request.body);
      if (!row) return reply.code(200).send({ success: true, recorded: false, reason: "no_changes" });
      return reply.code(201).send({ success: true, recorded: true, id: row.id });
    } catch (err) {
      if (err instanceof EditHistoryValidationError) {
        return reply.code(400).send({ success: false, error: err.message });
      }
      fastify.log.error({ err }, "[edit-history] failed to record");
      return reply.code(500).send({ success: false, error: "Failed to record edit history" });
    }
  });

  fastify.get("/edit-history", async (request, reply) => {
    const { eventId, limit, before } = request.query;
    if (!eventId) return reply.code(400).send({ success: false, error: "eventId is required" });
    if (before && Number.isNaN(Date.parse(before))) {
      return reply.code(400).send({ success: false, error: "before must be an ISO timestamp" });
    }
    try {
      const page = await listEditHistory({ eventId, limit, before });
      return reply.send({ success: true, ...page });
    } catch (err) {
      fastify.log.error({ err }, "[edit-history] failed to list");
      return reply.code(500).send({ success: false, error: "Failed to load edit history" });
    }
  });
}
