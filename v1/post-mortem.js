// v1/post-mortem.js
//
// POST /v1/post-mortem/generate
//   Header: x-internal-secret: <CRON_SECRET>
//   Body:   { eventId, eventName, requestedBy: { uid, email, username } }
//
//   Internal, service-to-service only — called by spotix-booker's own
//   POST /api/event/list/[eventId]/post-mortem route right after it has
//   confirmed the caller has access to the event's attendees tab AND that
//   the event has actually ended. Never called from the browser directly.
//
//   Claims generation via a single conditional Supabase write (see
//   lib/post-mortem/build.js#claimGeneration) so the "only ever generate
//   once" rule is a DB guarantee, not just a UI one. Responds once the
//   claim is resolved (fast), then — only if this call actually won the
//   claim — runs the real pipeline (Firestore read, PDF render, Storage
//   upload, email) in the background without making booker wait on it.
//
// GET /v1/post-mortem/status?eventId=
//   Header: x-internal-secret: <CRON_SECRET>
//
//   Returns the current status for an event's report. When status is
//   "ready", mints a fresh short-lived signed download URL on every call
//   (the bucket is private — nothing is ever publicly linkable).

import { requireInternalSecret } from "./lib/internal-auth.js";
import { claimGeneration, runGeneration } from "./lib/post-mortem/build.js";
import { supabaseAdmin } from "./lib/supabase-admin.js";

const TABLE = "post_mortems";
const BUCKET = "post-mortems";
const STATUS_SIGNED_URL_TTL_SECONDS = 600;

export default async function postMortemRoute(fastify, options) {
  fastify.post("/post-mortem/generate", async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;

    const { eventId, eventName, requestedBy } = request.body || {};
    if (!eventId || !eventName || !requestedBy?.uid || !requestedBy?.email) {
      return reply.code(400).send({
        success: false,
        error: "eventId, eventName, and requestedBy{uid,email} are required",
      });
    }

    let claim;
    try {
      claim = await claimGeneration({ eventId, eventName, requestedBy });
    } catch (err) {
      fastify.log.error(`[post-mortem/generate] claim failed for ${eventId}: ${err?.message}`);
      return reply.code(500).send({ success: false, error: "Failed to start post mortem generation" });
    }

    if (!claim.claimed) {
      return reply.code(200).send({
        success: true,
        status: claim.row?.status || "processing",
        alreadyExists: true,
      });
    }

    // Respond first — the caller doesn't need to wait on Firestore reads
    // or PDF rendering.
    reply.code(202).send({ success: true, status: "processing", started: true });

    runGeneration(fastify, { eventId, eventName, requestedBy }).catch((err) => {
      fastify.log.error(`[post-mortem/generate] background run crashed for ${eventId}: ${err?.message}`);
    });
  });

  fastify.get("/post-mortem/status", async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;

    const { eventId } = request.query || {};
    if (!eventId) {
      return reply.code(400).send({ success: false, error: "eventId is required" });
    }

    const { data: row, error } = await supabaseAdmin.from(TABLE).select("*").eq("event_id", eventId).maybeSingle();
    if (error) {
      fastify.log.error(`[post-mortem/status] lookup failed for ${eventId}: ${error.message}`);
      return reply.code(500).send({ success: false, error: "Failed to load post mortem status" });
    }

    if (!row) {
      return reply.code(200).send({ success: true, status: "none" });
    }

    if (row.status === "ready" && row.storage_path) {
      const { data: signed, error: signErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(row.storage_path, STATUS_SIGNED_URL_TTL_SECONDS);

      if (signErr) {
        fastify.log.error(`[post-mortem/status] signed URL failed for ${eventId}: ${signErr.message}`);
      }

      return reply.code(200).send({
        success: true,
        status: "ready",
        downloadUrl: signErr ? null : signed?.signedUrl || null,
        generatedAt: row.completed_at,
        requestedByUid: row.requested_by_uid || null,
        requestedByEmail: row.requested_by_email,
        requestedByName: row.requested_by_name || row.requested_by_username || null,
      });
    }

    return reply.code(200).send({
      success: true,
      status: row.status,
      error: row.status === "failed" ? row.error : undefined,
    });
  });
}
