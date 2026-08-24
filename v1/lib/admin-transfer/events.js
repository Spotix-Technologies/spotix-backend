/**
 * v1/lib/admin-transfer/events.js
 *
 * Resolves Paystack transfer.* webhook events for `admin_transfers`
 * rows (the Transfers menu — see spotix-admin's app/lib/transfers-db.ts
 * / supabase/admin-transfers-schema.sql) — a deliberate mirror of
 * v1/payout.js's processTransferEvents, which does the exact same job
 * for the `payouts` table (booker/poll organizer payouts).
 *
 * The two tables use disjoint reference prefixes (admin_transfers rows
 * are always "SPTX-XFER-...", payouts rows are always "SPTX-TRNS-...",
 * see spotix-admin's generateTransferReference()), so v1/webhook.js
 * dispatches to whichever of these two matches instead of querying both
 * tables on every webhook delivery.
 *
 * Idempotency: identical shape to payout.js — only acts on a row whose
 * CURRENT status is "processing"; a redelivered webhook for an
 * already-resolved row is a no-op.
 */

import { adminDb } from "../../firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { supabaseAdmin } from "../supabase-admin.js";

const TERMINAL_STATUSES = {
  "transfer.success":  "successful",
  "transfer.failed":   "failed",
  "transfer.reversed": "failed",
};

export function isAdminTransferReference(reference) {
  return typeof reference === "string" && reference.startsWith("SPTX-XFER-");
}

function getWATDateParts() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = `${year}-${get("month")}`;
  const day = `${month}-${get("day")}`;
  return { year, month, day };
}

export async function processAdminTransferEvents(fastify, events) {
  if (!events.length) return;

  for (const { event, data } of events) {
    const newStatus = TERMINAL_STATUSES[event];
    const reference = data?.reference;
    if (!newStatus || !reference) continue;

    fastify.log.info(`[admin-transfer] Processing ${event} for reference: ${reference}`);

    const updatePayload = {
      status: newStatus,
      resolved_at: new Date().toISOString(),
    };
    if (newStatus === "failed") {
      updatePayload.failure_reason = data?.gateway_response ?? data?.message ?? "No reason provided";
    }

    let transferRow;
    try {
      const { data: claimed, error } = await supabaseAdmin
        .from("admin_transfers")
        .update(updatePayload)
        .eq("reference", reference)
        .eq("status", "processing")
        .select()
        .maybeSingle();

      if (error) throw error;
      if (!claimed) {
        fastify.log.info(`[admin-transfer] ${reference} not in "processing" — skipping`);
        continue;
      }
      transferRow = claimed;
    } catch (err) {
      fastify.log.error({ err }, `[admin-transfer] Supabase update failed for ${reference}`);
      continue;
    }

    fastify.log.info(`[admin-transfer] ${reference} → ${newStatus}`);

    if (newStatus !== "successful") continue;

    // ── Analytics — recorded under the same payout counters as
    // booker/poll payouts (see v1/payout.js), per the brief ("records
    // the analytics under payouts"), plus a separate transferTotal/
    // transferCount pair so Transfers can be broken out later if needed.
    const { year, month, day } = getWATDateParts();
    const payload = {
      payout: FieldValue.increment(transferRow.amount_after_fee),
      payoutCount: FieldValue.increment(1),
      transferTotal: FieldValue.increment(transferRow.amount_after_fee),
      transferCount: FieldValue.increment(1),
      lastUpdated: FieldValue.serverTimestamp(),
    };
    const batch = adminDb.batch();
    const base = adminDb.collection("admin").doc("analytics");
    batch.set(base.collection("daily").doc(day), payload, { merge: true });
    batch.set(base.collection("monthly").doc(month), payload, { merge: true });
    batch.set(base.collection("yearly").doc(year), payload, { merge: true });

    try {
      await batch.commit();
      fastify.log.info(`[admin-transfer] Analytics committed for ${reference} — ₦${transferRow.amount_after_fee}`);
    } catch (err) {
      fastify.log.error({ err }, `[admin-transfer] Analytics batch failed for ${reference}`);
    }
  }
}
