import { adminDb } from "./firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";

const TERMINAL_STATUSES = {
  "transfer.success": "successful",
  "transfer.failed": "failed",
  "transfer.reversed": "reversed",
};

// Terminal statuses — used for idempotency guard
const TERMINAL_STATUS_SET = new Set(["successful", "failed", "reversed"]);

function getWATDateParts() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = `${year}-${get("month")}`;
  const day = `${month}-${get("day")}`;
  return { year, month, day };
}

export async function processTransferEvents(fastify, events) {
  if (!events.length) return;

  const errors = [];

  for (const { event, data } of events) {
    const newStatus = TERMINAL_STATUSES[event];
    const reference = data?.reference; // format: "{payoutId}AT{timestamp}"

    if (!newStatus || !reference) {
      fastify.log.warn(
        `[payout] Skipping event ${event} — missing reference or unknown status`
      );
      continue;
    }

    // ── Extract payoutId from reference ──────────────────────────────────────
    // Reference format: "{payoutId}AT{timestamp}" e.g. "abc123AT1712345678900"
    const atIndex = reference.lastIndexOf("AT");
    if (atIndex === -1) {
      fastify.log.warn(`[payout] Malformed reference — cannot extract payoutId: ${reference}`);
      continue;
    }
    const payoutId = reference.slice(0, atIndex);

    if (!payoutId) {
      fastify.log.warn(`[payout] Empty payoutId extracted from reference: ${reference}`);
      continue;
    }

    fastify.log.info(`[payout] Processing event ${event} for payoutId: ${payoutId}`);

    // ── Direct doc lookup by payoutId ────────────────────────────────────────
    const payoutRef = adminDb.collection("payouts").doc(payoutId);
    let payoutData;

    try {
      const payoutSnap = await payoutRef.get();
      if (!payoutSnap.exists) {
        fastify.log.warn(`[payout] No payout doc found for payoutId: ${payoutId}`);
        continue;
      }
      payoutData = payoutSnap.data();
    } catch (err) {
      fastify.log.error(`[payout] Firestore lookup error for payoutId ${payoutId}:`, err);
      errors.push(payoutId);
      continue;
    }

    // ── Idempotency guard ────────────────────────────────────────────────────
    if (TERMINAL_STATUS_SET.has(payoutData.status)) {
      fastify.log.info(
        `[payout] Already in terminal status "${payoutData.status}" — skipping duplicate webhook for payoutId: ${payoutId}`
      );
      continue;
    }

    // ── Build payout status update ───────────────────────────────────────────
    const payoutUpdate = {
      status: newStatus,
      updatedAt: FieldValue.serverTimestamp(),
      processedAt: FieldValue.serverTimestamp(),
    };

    if (newStatus === "failed" || newStatus === "reversed") {
      payoutUpdate.failureReason =
        data?.gateway_response ?? data?.message ?? "No reason provided";
    }

    // ── Commit payout status ─────────────────────────────────────────────────
    try {
      await payoutRef.update(payoutUpdate);
      fastify.log.info(`[payout] Updated: ${payoutId} → ${newStatus}`);
    } catch (err) {
      fastify.log.error(`[payout] Failed to update payout doc ${payoutId}:`, err);
      errors.push(payoutId);
      continue;
    }

    // ── Analytics — successful transfers only ────────────────────────────────
    if (newStatus !== "successful") continue;

    const { eventId, userId, amount } = payoutData;

    if (!eventId || !userId || !amount) {
      fastify.log.warn(
        `[payout] Skipping analytics for ${payoutId} — missing eventId, userId, or amount`
      );
      continue;
    }

    const { year, month, day } = getWATDateParts();

    const analyticsPayload = {
      payout: FieldValue.increment(amount),
      payoutCount: FieldValue.increment(1),
      lastUpdated: FieldValue.serverTimestamp(),
    };

    const analyticsBatch = adminDb.batch();

    // 1. Admin analytics — daily / monthly / yearly
    const base = adminDb.collection("admin").doc("analytics");
    analyticsBatch.set(base.collection("daily").doc(day), analyticsPayload, { merge: true });
    analyticsBatch.set(base.collection("monthly").doc(month), analyticsPayload, { merge: true });
    analyticsBatch.set(base.collection("yearly").doc(year), analyticsPayload, { merge: true });

    // 2. Organizer — users/{userId}.totalPaidOut
    analyticsBatch.update(adminDb.collection("users").doc(userId), {
      totalPaidOut: FieldValue.increment(amount),
    });

    // 3. Event — events/{eventId}.totalPaidOut
    analyticsBatch.update(adminDb.collection("events").doc(eventId), {
      totalPaidOut: FieldValue.increment(amount),
    });

    try {
      await analyticsBatch.commit();
      fastify.log.info(
        `[payout] Analytics committed for payout ${payoutId} — ₦${amount} to event ${eventId}`
      );
    } catch (err) {
      fastify.log.error(`[payout] Analytics batch failed for payout ${payoutId}:`, err);
    }
  }

  if (errors.length) {
    fastify.log.warn(`[payout] ${errors.length} transfer(s) had errors:`, errors);
  }
}