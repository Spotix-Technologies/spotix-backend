/**
 * v1/payout.js
 *
 * Processes Paystack transfer webhook events for the payout cycle.
 *
 * The `payouts` table now lives in Supabase (see /supabase/payout-schema.sql)
 * — this used to update a Firestore `payouts/{id}` doc found by parsing a
 * `{payoutId}AT{timestamp}` reference. Now the Paystack reference IS the
 * Supabase row's primary key (`reference`, e.g. SPTX-TRNS-...), set at
 * transfer-initiation time in v1/lib/payout/process.js, so resolution is
 * a direct lookup — no parsing required.
 *
 * Idempotency: only acts on a row whose CURRENT status is "processing" —
 * a redelivered webhook for an already-resolved row is a no-op. This is
 * the same "only one caller ever transitions the terminal state" shape
 * as v1/lib/voting/reference.js's credit lock, just enforced with a
 * conditional UPDATE instead of a Firestore transaction.
 */

import { adminDb } from "./firebase-admin.js"
import { FieldValue } from "firebase-admin/firestore"
import { supabaseAdmin } from "./lib/supabase-admin.js"
import { notifyPayoutStatus } from "./lib/notify-payout.js"

const TERMINAL_STATUSES = {
  "transfer.success":  "successful",
  "transfer.failed":   "failed",
  "transfer.reversed": "failed",
}

function getWATDateParts() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric", month: "2-digit", day: "2-digit",
  })
  const parts = formatter.formatToParts(new Date())
  const get   = (type) => parts.find((p) => p.type === type)?.value ?? ""
  const year  = get("year")
  const month = `${year}-${get("month")}`
  const day   = `${month}-${get("day")}`
  return { year, month, day }
}

export async function processTransferEvents(fastify, events) {
  if (!events.length) return

  const errors = []

  for (const { event, data } of events) {
    const newStatus = TERMINAL_STATUSES[event]
    const reference = data?.reference // our SPTX-TRNS-... reference, echoed back verbatim

    if (!newStatus || !reference) {
      fastify.log.warn(`[payout] Skipping event ${event} — missing reference or unknown status`)
      continue
    }

    fastify.log.info(`[payout] Processing ${event} for reference: ${reference}`)

    // ── Idempotent claim: only proceed if currently "processing" ───────────
    const failureReason =
      event === "transfer.reversed"
        ? (data?.gateway_response ?? data?.message ?? "Transfer was reversed")
        : (data?.gateway_response ?? data?.message ?? "No reason provided")

    const updatePayload = {
      status: newStatus,
      resolved_at: new Date().toISOString(),
    }
    if (newStatus === "failed") {
      updatePayload.failure_reason = failureReason
    }

    let payoutRow
    try {
      const { data: claimed, error } = await supabaseAdmin
        .from("payouts")
        .update(updatePayload)
        .eq("reference", reference)
        .eq("status", "processing")
        .select()
        .maybeSingle()

      if (error) throw error

      if (!claimed) {
        fastify.log.info(`[payout] ${reference} not in "processing" (already resolved or unknown) — skipping`)
        continue
      }
      payoutRow = claimed
    } catch (err) {
      fastify.log.error({ err }, `[payout] Supabase update failed for ${reference}`)
      errors.push(reference)
      continue
    }

    // ── Duration: freeze the live timer at its final value ─────────────────
    const durationSeconds = payoutRow.created_at
      ? Math.max(0, Math.round((Date.now() - new Date(payoutRow.created_at).getTime()) / 1000))
      : 0
    try {
      await supabaseAdmin.from("payouts").update({ duration_seconds: durationSeconds }).eq("reference", reference)
    } catch (err) {
      fastify.log.warn({ err }, `[payout] Failed to write duration_seconds for ${reference}`)
    }

    fastify.log.info(`[payout] ${reference} → ${newStatus}${newStatus === "failed" ? ` (${failureReason})` : ""}`)

    // ── Telegram notification — fire-and-forget, never awaited ───────────────
    notifyPayoutStatus(fastify, {
      userId: payoutRow.user_id,
      status: newStatus,
      eventId: payoutRow.event_id,
      date: payoutRow.pay_date,
      failureReason: newStatus === "failed" ? failureReason : undefined,
    })

    // ── Analytics — successful only ─────────────────────────────────────────
    if (newStatus !== "successful") continue

    const { user_id: userId, amount, is_poll: isPollPayout, event_id: eventId, poll_id: pollId } = payoutRow

    if (!userId || !amount) {
      fastify.log.warn(`[payout] Skipping analytics for ${reference} — missing userId or amount`)
      continue
    }

    const { year, month, day } = getWATDateParts()
    const analyticsPayload = {
      payout:      FieldValue.increment(amount),
      payoutCount: FieldValue.increment(1),
      lastUpdated: FieldValue.serverTimestamp(),
    }

    const batch = adminDb.batch()
    const base  = adminDb.collection("admin").doc("analytics")

    // 1. Admin analytics
    batch.set(base.collection("daily").doc(day),     analyticsPayload, { merge: true })
    batch.set(base.collection("monthly").doc(month), analyticsPayload, { merge: true })
    batch.set(base.collection("yearly").doc(year),   analyticsPayload, { merge: true })

    // 2. User totalPaidOut
    batch.update(adminDb.collection("users").doc(userId), {
      totalPaidOut: FieldValue.increment(amount),
    })

    if (isPollPayout) {
      if (pollId) {
        batch.update(adminDb.collection("voting").doc(pollId), {
          totalPaidOut: FieldValue.increment(amount),
        })
      }
    } else if (eventId) {
      batch.update(adminDb.collection("events").doc(eventId), {
        totalPaidOut: FieldValue.increment(amount),
      })
    }

    try {
      await batch.commit()
      fastify.log.info(
        `[payout] Analytics committed for ${reference} (${isPollPayout ? "poll" : "event"}) — ₦${amount}`
      )
    } catch (err) {
      fastify.log.error({ err }, `[payout] Analytics batch failed for ${reference}`)
    }
  }

  if (errors.length) {
    fastify.log.warn(`[payout] ${errors.length} transfer(s) with errors:`, errors)
  }
}
