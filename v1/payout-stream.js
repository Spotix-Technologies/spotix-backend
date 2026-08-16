/**
 * v1/payout-stream.js
 *
 * GET /v1/payout/stream?reference=SPTX-TRNS-...
 * Header: x-internal-secret: <CRON_SECRET>
 *
 * Internal, service-to-service only — spotix-booker's own
 * app/api/payout/stream/route.ts is the thing that actually talks to
 * the browser (authenticated there via the normal spotix_at cookie).
 * That route proxies this endpoint. The browser never touches this
 * route, this backend's Supabase project, or any Supabase key directly.
 *
 * Why: Supabase Realtime authorization is evaluated per-row against
 * whatever RLS policy is attached to the anon key — there's no way to
 * scope an anon-key subscription to "just this one reference" without
 * ALSO granting that anon key SELECT on the whole `payouts` table
 * (bank details, names, amounts, everything). Relaying server-side with
 * the service-role key avoids that entirely: the only thing that ever
 * reaches the browser is the JSON this route chooses to emit.
 *
 * Behaviour:
 *   - Sends the row's current state immediately as the first event.
 *   - If already terminal (successful/failed), sends that and closes.
 *   - Otherwise subscribes to postgres_changes for that one reference
 *     and relays every update until a terminal status is reached or the
 *     client disconnects.
 *   - A 25s heartbeat comment keeps the connection alive through
 *     proxies/load balancers that timeout idle connections.
 *   - A 4s poll runs ALONGSIDE the realtime subscription as a
 *     guaranteed-delivery fallback. postgres_changes requires the
 *     `payouts` table to be added to the `supabase_realtime` publication
 *     (`alter publication supabase_realtime add table public.payouts;`)
 *     — if that was never run, or the websocket silently drops without
 *     firing an error event, the client would otherwise sit on
 *     "processing" forever even though the row resolved fine. The poll
 *     is a plain SELECT so it works regardless of publication/replica
 *     identity config, and it's deduped against whatever the realtime
 *     path already sent so terminal resolution is never emitted twice.
 */

import { supabaseAdmin } from "./lib/supabase-admin.js";
import { isValidPayoutReference } from "./lib/payout/reference.js";

function shapePayout(row) {
  if (!row) return null;
  return {
    reference: row.reference,
    status: row.status,
    isEvent: row.is_event,
    isPoll: row.is_poll,
    eventName: row.event_name ?? null,
    pollName: row.poll_name ?? null,
    payDate: row.pay_date,
    amount: row.amount,
    narration: row.narration ?? null,
    failureReason: row.failure_reason ?? null,
    durationSeconds: row.duration_seconds ?? 0,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

const TERMINAL = new Set(["successful", "failed"]);

export default async function payoutStreamRoute(fastify, options) {
  fastify.get("/payout/stream", async (request, reply) => {
    const secret = request.headers["x-internal-secret"];
    if (!secret || secret !== process.env.CRON_SECRET) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { reference } = request.query;
    if (!isValidPayoutReference(reference)) {
      return reply.code(400).send({ error: "Missing or malformed reference" });
    }

    // Tell Fastify we're taking over the raw response ourselves — without
    // this it will warn/hang waiting for reply.send(), since we never
    // call it (the stream ends via cleanup()/reply.raw.end() instead).
    reply.hijack();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event, data) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let channel = null;
    let closed = false;
    let lastSentStatus = null;
    // Declared here (not with the `const pollFallback = setInterval(...)`
    // below) because cleanup() can run before that line — e.g. the initial
    // Supabase fetch failing — and referencing a later `const` from this
    // closure before its declaration line runs is a TDZ ReferenceError.
    let pollFallback = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(pollFallback);
      if (channel) {
        supabaseAdmin.removeChannel(channel);
        channel = null;
      }
      try {
        reply.raw.end();
      } catch {
        // already closed
      }
    };

    // Emits a row's status once, skipping it if we've already sent this
    // exact status (realtime and the poll fallback can both observe the
    // same transition — this keeps the stream from double-emitting).
    const emit = (row) => {
      if (!row || closed || row.status === lastSentStatus) return;
      lastSentStatus = row.status;
      send("status", shapePayout(row));
      if (TERMINAL.has(row.status)) cleanup();
    };

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat\n\n`);
      } catch {
        cleanup();
      }
    }, 25_000);

    request.raw.on("close", cleanup);

    // ── Initial snapshot ─────────────────────────────────────────────────
    let initial;
    try {
      const { data, error } = await supabaseAdmin
        .from("payouts")
        .select("*")
        .eq("reference", reference)
        .maybeSingle();
      if (error) throw error;
      initial = data;
    } catch (err) {
      fastify.log.error({ err }, `[payout-stream] Failed initial fetch for ${reference}`);
      send("error", { message: "Failed to load payout status" });
      cleanup();
      return;
    }

    if (!initial) {
      send("error", { message: "Payout reference not found" });
      cleanup();
      return;
    }

    lastSentStatus = initial.status;
    send("status", shapePayout(initial));

    if (TERMINAL.has(initial.status)) {
      cleanup();
      return;
    }

    // ── Live updates (fast path) ────────────────────────────────────────
    channel = supabaseAdmin
      .channel(`payout-stream-${reference}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "payouts", filter: `reference=eq.${reference}` },
        (payload) => emit(payload.new)
      )
      .subscribe((status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          fastify.log.warn(
            { err },
            `[payout-stream] realtime channel ${status} for ${reference} — poll fallback will still catch resolution`
          );
        }
      });

    // ── Poll fallback (guaranteed path) ─────────────────────────────────
    // Covers the case where realtime is misconfigured (table never added
    // to the supabase_realtime publication) or the channel silently
    // stalls without an error event. Worst-case delay to the browser is
    // ~4s instead of instant, but it WILL resolve.
    pollFallback = setInterval(async () => {
      if (closed) return;
      try {
        const { data, error } = await supabaseAdmin
          .from("payouts")
          .select("*")
          .eq("reference", reference)
          .maybeSingle();
        if (error) throw error;
        emit(data);
      } catch (err) {
        fastify.log.warn({ err }, `[payout-stream] poll fallback query failed for ${reference}`);
      }
    }, 4_000);

    // Fastify won't wait on this handler forever by default in some
    // configs — returning a never-resolving promise here would hang the
    // connection pool, so instead we just return once wired up; the
    // response stream stays open via reply.raw until cleanup() ends it.
  });
}
