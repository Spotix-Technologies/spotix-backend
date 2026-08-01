/**
 * v1/voting.js
 *
 * Dedicated webhook handler for voting_purchase charge events.
 * Imported into v1/webhook.js.
 *
 * Firestore layout (FLAT):
 *   Reference/{reference}     ← payment reference (sptx-vt-{timestamp})
 *                                (same collection ticket.js uses — capital "Reference")
 *   voting/{pollId}           ← flat poll document, contains creatorId field
 *   voting/{pollId}/entries/{reference} ← one doc per vote purchase (mirrors
 *                                          events/{eventId}/attendees/{ticketId} in ticket.js)
 *   votingHistory/{reference} ← global vote-purchase record (mirrors tickets/{ticketId})
 *   admin/votes/{pollId}/{YYYY-MM-DD} ← daily aggregation, mirrors
 *                                        admin/events/{eventId}/{date} (ticket.js Step 8)
 *
 * Poll types:
 *   "single" → contestants[] (flat)
 *   "group"  → categories[] tree with optional subcategories (nested)
 *              Vote targets the leaf category identified by categoryId.
 *
 * Royalty / service fee (mirrors booker/app/lib/poll-config.ts — keep in sync):
 *   ROYALTY_PERCENT = 5
 *   buyerBearsBurden (immutable, set on voting/{pollId} at poll creation):
 *     true  → buyer absorbs the fee; poll receives the vote's base amount
 *              (serviceFee = calcServiceFee(baseAmount), same formula as poll-config.ts)
 *     false → creator absorbs the fee; poll receives 95% of totalAmount
 *              (serviceFee = 5% of totalAmount, same as calcSellerNet in poll-config.ts)
 *   The NET amount (totalAmount − serviceFee) is what gets credited to
 *   voting/{pollId}.pollAmount, the daily admin/votes doc, and the creator's
 *   user/{creatorId} stats — i.e. it's the only amount that is ever payable out.
 *
 * On charge.success:
 *   1. Updates reference status → successful   (ALWAYS — reference must exist)
 *   2. Increments contestant votes
 *      single:  voting/{pollId}.contestants[n].votes
 *      group:   voting/{pollId}.categories tree → finds leaf by categoryId → contestant
 *   3. Updates pollCount, pollAmount (NET); writes voting/{pollId}/entries/{reference}
 *      and votingHistory/{reference} (scalable per-doc records — no more unbounded
 *      pollEntries array on the poll document)
 *   4. Updates admin/votes/{pollId}/{date} daily aggregation (NET, payout-eligible)
 *   5. Updates user/{creatorId} stats (totalRevenue, totalVotesSold)
 *   6. Updates admin analytics (totalRevenue, totalVotes, totalTransactionFees) — daily/monthly/yearly
 */

import { adminDb } from "./firebase-admin.js"
import { FieldValue } from "firebase-admin/firestore"
import { invalidatePollCache } from "./redis.js"

// ── Royalty / service fee helpers (mirrors booker/app/lib/poll-config.ts) ───────

const ROYALTY_PERCENT = 5

/** Service fee charged on top of baseAmount when the buyer bears the burden. */
function calcServiceFee(baseAmount) {
  const buyerTotal = Math.round(baseAmount * (1 + ROYALTY_PERCENT / 100))
  return buyerTotal - baseAmount
}

/** Net amount the creator/poll receives when the creator bears the burden. */
function calcSellerNet(grossAmount) {
  return Math.round(grossAmount * (1 - ROYALTY_PERCENT / 100))
}

/**
 * Compute the service fee and net (payable) amount for a vote transaction.
 *
 * @param buyerBearsBurden - from voting/{pollId}.buyerBearsBurden (authoritative)
 * @param totalAmount      - gross amount actually paid by the voter
 * @param baseAmount       - pollPrice × voteCount (the organiser's clean price)
 */
function computeVoteFee(buyerBearsBurden, totalAmount, baseAmount) {
  if (buyerBearsBurden) {
    // Buyer already absorbed the fee — poll should net out to ~baseAmount.
    const fee = Math.min(calcServiceFee(baseAmount), totalAmount)
    return { serviceFee: fee, netAmount: totalAmount - fee }
  }
  // Creator bears the burden — 5% comes off the top before it's payable.
  const netAmount = calcSellerNet(totalAmount)
  return { serviceFee: totalAmount - netAmount, netAmount }
}

// ── WAT helpers ────────────────────────────────────────────────────────────────

function getWATDateParts() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric", month: "2-digit", day: "2-digit",
  })
  const parts = formatter.formatToParts(new Date())
  const get   = (t) => parts.find((p) => p.type === t)?.value ?? ""
  const year  = get("year")
  const month = `${year}-${get("month")}`
  const day   = `${month}-${get("day")}`
  return { year, month, day }
}

// ── Nested category helpers ────────────────────────────────────────────────────

/**
 * Recursively walk the category tree and increment the target contestant's
 * votes inside the leaf category identified by targetCategoryId.
 *
 * Returns a NEW array (no mutation) and a flag indicating if the target was found.
 */
function allocateGroupVote(categories, targetCategoryId, contestantId, numVotes) {
  let found = false
  const updated = categories.map((cat) => {
    if (found) return cat

    if (cat.categoryId === targetCategoryId) {
      // This is the leaf category — update the contestant
      found = true
      return {
        ...cat,
        contestants: (cat.contestants ?? []).map((c) =>
          c.contestantId === contestantId
            ? { ...c, votes: (c.votes ?? 0) + numVotes }
            : c
        ),
      }
    }

    // Recurse into subcategories
    if (Array.isArray(cat.subcategories) && cat.subcategories.length > 0) {
      const subResult = allocateGroupVote(cat.subcategories, targetCategoryId, contestantId, numVotes)
      if (subResult.found) {
        found = true
        return { ...cat, subcategories: subResult.updated }
      }
    }

    return cat
  })

  return { updated, found }
}

// ─── Main handler ──────────────────────────────────────────────────────────────

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {"charge.success"|"charge.failed"} event
 * @param {object} data   — Paystack event data
 * @param {string} reference — sptx-vt-{timestamp}
 */
export async function processVotingCharge(fastify, event, data, reference) {
  const paymentStatus = event === "charge.success" ? "successful" : "failed"

  // ── 1. Fetch reference doc ─────────────────────────────────────────────────
  const referenceRef = adminDb.collection("Reference").doc(reference)
  let refDoc
  try {
    refDoc = await referenceRef.get()
  } catch (err) {
    fastify.log.error(`[voting] Firestore get failed for reference ${reference}:`, err)
    throw err
  }

  if (!refDoc.exists) {
    fastify.log.warn(`[voting] Reference not found: ${reference}`)
    return { status: "not_found", reference }
  }

  const refData = refDoc.data()

  // ── 2. Idempotency guard ───────────────────────────────────────────────────
  if (refData.status === "successful" || refData.status === "failed") {
    fastify.log.info(`[voting] ${reference} already "${refData.status}" — skipped`)
    return { status: "already_processed", reference }
  }

  // ── 3. Update reference ────────────────────────────────────────────────────
  const referenceUpdate = {
    status:        paymentStatus,
    updatedAt:     new Date().toISOString(),
    paystackEvent: event,
    amount:        data?.amount   ?? null,
    currency:      data?.currency ?? null,
    customer: {
      email:        data?.customer?.email         ?? null,
      customerCode: data?.customer?.customer_code ?? null,
    },
  }

  if (paymentStatus === "successful") {
    referenceUpdate.paymentCompletedAt = new Date().toISOString()
  } else {
    referenceUpdate.failureReason   = data?.gateway_response ?? "Payment failed"
    referenceUpdate.paymentFailedAt = new Date().toISOString()
  }

  try {
    await referenceRef.update(referenceUpdate)
    fastify.log.info(`[voting] Reference ${reference} → ${paymentStatus}`)
  } catch (err) {
    fastify.log.error(`[voting] Failed to update reference ${reference}:`, err)
    throw err
  }

  if (paymentStatus === "failed") {
    return { status: "failed", reference }
  }

  // ── 4. Allocate votes ──────────────────────────────────────────────────────
  const {
    pollId,
    voteId,
    contestantId,
    categoryId,     // present for group polls (leaf category)
    voteCount,
    totalAmount,
    pollPrice,
  } = refData

  const targetPollId = pollId ?? voteId ?? null

  if (!targetPollId || !contestantId) {
    fastify.log.warn(`[voting] Missing pollId/contestantId on reference ${reference} — skipping allocation`)
    return { status: "successful_no_allocation", reference }
  }

  const pollRef = adminDb.collection("voting").doc(targetPollId)

  // Hoisted so Step 5 (admin analytics) can reuse the same fee computation.
  // Defaults are the "no poll found" fallback — treated as buyer-bears-burden
  // with zero fee so we never silently invent a royalty deduction.
  let buyerBearsBurden = true
  let serviceFee       = 0
  let netAmount         = Number(totalAmount ?? 0)
  let creatorId        = null

  try {
    const pollSnap = await pollRef.get()

    if (!pollSnap.exists) {
      fastify.log.warn(`[voting] Poll ${targetPollId} not found`)
    } else {
      const pollData = pollSnap.data()
      const pollType = pollData?.pollType ?? "single"
      const numVotes = Number(voteCount  ?? 1)
      const numAmt   = Number(totalAmount ?? 0)
      const baseAmt  = Number(pollPrice ?? 0) * numVotes

      creatorId        = pollData?.creatorId ?? pollData?.organizerId ?? null
      buyerBearsBurden = pollData?.buyerBearsBurden ?? true

      const fee = computeVoteFee(buyerBearsBurden, numAmt, baseAmt)
      serviceFee = fee.serviceFee
      netAmount  = fee.netAmount

      const voteEntry = {
        uid:             refData.userId      ?? refData.payerEmail ?? null,
        payerName:       refData.payerName   ?? null,
        payerEmail:      refData.payerEmail  ?? null,
        payerPhone:      refData.payerPhone  ?? null,
        voteCount:       numVotes,
        price:           Number(pollPrice    ?? 0),
        contestantId,
        contestantName:  refData.contestantName ?? "",
        categoryId:      categoryId ?? null,
        date:            new Date().toISOString(),
        reference,
        isGuest:         refData.isGuest ?? false,
        totalAmount:     numAmt,
        netAmount,
        buyerBearsBurden,
        serviceFee,
      }

      if (pollType === "group" && categoryId) {
        // ── Group poll: find leaf category and update contestant ────────────
        const categories = pollData?.categories ?? []
        const { updated: updatedCategories, found } = allocateGroupVote(
          categories, categoryId, contestantId, numVotes
        )

        if (!found) {
          fastify.log.warn(
            `[voting] [group] Category ${categoryId} not found in poll ${targetPollId} — vote entry recorded but no vote counted`
          )
        }

        await pollRef.update({
          categories:  updatedCategories,
          pollCount:   FieldValue.increment(numVotes),
          pollAmount:  FieldValue.increment(netAmount),
          updatedAt:   FieldValue.serverTimestamp(),
        })

        fastify.log.info(
          `[voting] [group] Allocated ${numVotes} vote(s) to ${contestantId} in category ${categoryId} on poll ${targetPollId}`
        )

      } else {
        // ── Single poll: update flat contestants array ──────────────────────
        const contestants        = pollData?.contestants ?? []
        const updatedContestants = contestants.map((c) =>
          c.contestantId === contestantId
            ? { ...c, votes: (c.votes ?? 0) + numVotes }
            : c
        )

        await pollRef.update({
          contestants:  updatedContestants,
          pollCount:    FieldValue.increment(numVotes),
          pollAmount:   FieldValue.increment(netAmount),
          updatedAt:    FieldValue.serverTimestamp(),
        })

        fastify.log.info(
          `[voting] [single] Allocated ${numVotes} vote(s) to ${contestantId} on poll ${targetPollId}`
        )
      }

      // spotix-user's public voting-poll page caches this poll for up to
      // 15s (see voting-poll-lookup:* in voting-utils.ts) precisely
      // because there was no invalidation hook into this webhook — this
      // closes that gap, so a vote shows up on the page immediately
      // instead of waiting out the TTL. Never allowed to fail the
      // webhook: a stale page for up to 15s is fine, a failed payment
      // credit is not.
      try {
        await invalidatePollCache(targetPollId)
      } catch (err) {
        fastify.log.warn(`[voting] Cache invalidation failed for poll ${targetPollId} (non-blocking):`, err)
      }

      // ── 4a. Scalable per-vote records ────────────────────────────────────
      // Replaces the old unbounded voting/{pollId}.pollEntries array with two
      // per-doc writes, mirroring ticket.js's tickets/{ticketId} + attendees
      // pattern:
      //   voting/{pollId}/entries/{reference}  — poll-scoped, powers the
      //                                          booker's "Entries" tab
      //   votingHistory/{reference}            — global record, one per vote
      //                                          purchase, for cross-poll lookups
      // Keyed by reference so this is naturally idempotent if ever re-run.
      try {
        await pollRef.collection("entries").doc(reference).set(voteEntry)

        await adminDb.collection("votingHistory").doc(reference).set({
          ...voteEntry,
          pollId:     targetPollId,
          pollName:   pollData?.pollName ?? "",
          pollType,
          creatorId,
        })

        fastify.log.info(`[voting] Entry recorded — voting/${targetPollId}/entries/${reference} + votingHistory/${reference}`)
      } catch (err) {
        fastify.log.error(`[voting] Failed to write vote entry docs for ${reference} (non-blocking):`, err)
      }

      // ── 4b. Daily payout-eligible aggregation ───────────────────────────
      // admin/votes/{pollId}/{YYYY-MM-DD} — mirrors ticket.js Step 8
      // (admin/events/{eventId}/{date}). voteSales is NET (post-fee) since
      // that is the only amount ever eligible for payout.
      try {
        const { day } = getWATDateParts()
        const nowIso = new Date().toISOString()
        const dailyRef = adminDb
          .collection("admin")
          .doc("votes")
          .collection(targetPollId)
          .doc(day)

        const dailySnap = await dailyRef.get()
        if (!dailySnap.exists) {
          await dailyRef.set({
            pollName:     pollData?.pollName ?? "",
            voteCount:    numVotes,
            voteSales:    netAmount,
            lastVoteTime: nowIso,
            createdAt:    nowIso,
            lastUpdated:  nowIso,
          })
        } else {
          await dailyRef.update({
            voteCount:    FieldValue.increment(numVotes),
            voteSales:    FieldValue.increment(netAmount),
            lastVoteTime: nowIso,
            lastUpdated:  nowIso,
          })
        }

        fastify.log.info(`[voting] Daily votes updated for poll ${targetPollId} on ${day}`)
      } catch (err) {
        fastify.log.error(`[voting] Daily aggregation failed for ${reference} (non-blocking):`, err)
      }

      // ── 4c. Creator stats — user/{creatorId} ────────────────────────────
      // Shares the same fields ticket sales use (atomic/route.ts) so the
      // booker dashboard shows a single combined total across events + polls.
      if (creatorId) {
        try {
          const creatorRef  = adminDb.collection("users").doc(creatorId)
          const creatorSnap = await creatorRef.get()
          if (creatorSnap.exists) {
            await creatorRef.update({
              totalRevenue:   FieldValue.increment(netAmount),
              totalVotesSold: FieldValue.increment(numVotes),
            })
            fastify.log.info(`[voting] Creator stats updated for ${creatorId} — ₦${netAmount}`)
          } else {
            fastify.log.warn(`[voting] Creator doc ${creatorId} not found — skipping stats update`)
          }
        } catch (err) {
          fastify.log.error(`[voting] Creator stats update failed for ${reference} (non-blocking):`, err)
        }
      } else {
        fastify.log.warn(`[voting] No creatorId on poll ${targetPollId} — skipping creator stats`)
      }
    }
  } catch (err) {
    // Non-fatal — payment recorded; vote can be re-processed
    fastify.log.error(`[voting] Vote allocation failed for ${reference} (non-blocking):`, err)
  }

  // ── 5. Admin analytics ─────────────────────────────────────────────────────
  try {
    const { year, month, day } = getWATDateParts()
    const base    = adminDb.collection("admin").doc("analytics")
    const numVotes = Number(voteCount  ?? 1)
    const numAmt   = Number(totalAmount ?? 0)

    const payload = {
      totalRevenue: FieldValue.increment(numAmt),
      totalVotes:   FieldValue.increment(numVotes),
      lastUpdated:  FieldValue.serverTimestamp(),
    }

    // Only track totalTransactionFees when the buyer bore the burden — that's
    // the only case where the fee is a distinct, separately-charged amount.
    if (buyerBearsBurden) {
      payload.totalTransactionFees = FieldValue.increment(serviceFee)
    }

    const batch = adminDb.batch()
    batch.set(base.collection("daily").doc(day),     payload, { merge: true })
    batch.set(base.collection("monthly").doc(month), payload, { merge: true })
    batch.set(base.collection("yearly").doc(year),   payload, { merge: true })
    await batch.commit()

    fastify.log.info(`[voting] Analytics updated — ₦${numAmt} / ${numVotes} vote(s)`)
  } catch (err) {
    fastify.log.error(`[voting] Analytics update failed for ${reference} (non-blocking):`, err)
  }

  return { status: "successful", reference }
}
