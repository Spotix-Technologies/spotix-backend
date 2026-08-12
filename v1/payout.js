/**
 * v1/payout.js
 *
 * Processes Paystack transfer webhook events for the payout cycle.
 * Handles event payouts and poll payouts (type: "poll_payout").
 *
 * Poll payouts update the FLAT voting/{pollId} document.
 */

import { adminDb } from "./firebase-admin.js"
import { FieldValue } from "firebase-admin/firestore"
import { notifyPayoutStatus } from "./lib/notify-payout.js"

const TERMINAL_STATUSES = {
  "transfer.success":  "successful",
  "transfer.failed":   "failed",
  "transfer.reversed": "reversed",
}

const TERMINAL_STATUS_SET = new Set(["successful", "failed", "reversed"])

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
    const reference = data?.reference  // "{payoutId}AT{timestamp}"

    if (!newStatus || !reference) {
      fastify.log.warn(`[payout] Skipping event ${event} — missing reference or unknown status`)
      continue
    }

    // ── Extract payoutId ────────────────────────────────────────────────────
    const atIndex = reference.lastIndexOf("AT")
    if (atIndex === -1) {
      fastify.log.warn(`[payout] Malformed reference: ${reference}`)
      continue
    }
    const payoutId = reference.slice(0, atIndex)
    if (!payoutId) {
      fastify.log.warn(`[payout] Empty payoutId from reference: ${reference}`)
      continue
    }

    fastify.log.info(`[payout] Processing ${event} for payoutId: ${payoutId}`)

    // ── Fetch payout doc ────────────────────────────────────────────────────
    const payoutRef = adminDb.collection("payouts").doc(payoutId)
    let payoutData

    try {
      const snap = await payoutRef.get()
      if (!snap.exists) {
        fastify.log.warn(`[payout] No payout doc for payoutId: ${payoutId}`)
        continue
      }
      payoutData = snap.data()
    } catch (err) {
      fastify.log.error(`[payout] Firestore lookup error for ${payoutId}:`, err)
      errors.push(payoutId)
      continue
    }

    // ── Idempotency ─────────────────────────────────────────────────────────
    if (TERMINAL_STATUS_SET.has(payoutData.status)) {
      fastify.log.info(`[payout] Already "${payoutData.status}" — skipping ${payoutId}`)
      continue
    }

    // ── Update payout status ────────────────────────────────────────────────
    const payoutUpdate = {
      status:      newStatus,
      updatedAt:   FieldValue.serverTimestamp(),
      processedAt: FieldValue.serverTimestamp(),
    }

    if (newStatus === "failed" || newStatus === "reversed") {
      payoutUpdate.failureReason = data?.gateway_response ?? data?.message ?? "No reason provided"
    }

    try {
      await payoutRef.update(payoutUpdate)
      fastify.log.info(`[payout] Updated ${payoutId} → ${newStatus}`)
    } catch (err) {
      fastify.log.error(`[payout] Failed to update payout doc ${payoutId}:`, err)
      errors.push(payoutId)
      continue
    }

    // ── Telegram notification — fire-and-forget, never awaited ───────────────
    notifyPayoutStatus(fastify, {
      userId: payoutData.userId,
      status: newStatus,
      eventId: payoutData.eventId,
      date: payoutData.date,
      failureReason: payoutUpdate.failureReason,
    })

    // ── Analytics — successful only ─────────────────────────────────────────
    if (newStatus !== "successful") continue

    const { userId, amount, type } = payoutData
    const isPollPayout = type === "poll_payout"

    if (!userId || !amount) {
      fastify.log.warn(`[payout] Skipping analytics for ${payoutId} — missing userId or amount`)
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
      // 3a. FLAT voting/{pollId} — update totalPaidOut
      const { pollId } = payoutData
      if (pollId) {
        batch.update(adminDb.collection("voting").doc(pollId), {
          totalPaidOut: FieldValue.increment(amount),
        })
      }
    } else {
      // 3b. events/{eventId} — original event payout behaviour
      const { eventId } = payoutData
      if (eventId) {
        batch.update(adminDb.collection("events").doc(eventId), {
          totalPaidOut: FieldValue.increment(amount),
        })
      }
    }

    try {
      await batch.commit()
      fastify.log.info(
        `[payout] Analytics committed for ${payoutId} (${isPollPayout ? "poll" : "event"}) — ₦${amount}`
      )
    } catch (err) {
      fastify.log.error(`[payout] Analytics batch failed for ${payoutId}:`, err)
    }
  }

  if (errors.length) {
    fastify.log.warn(`[payout] ${errors.length} transfer(s) with errors:`, errors)
  }
}
