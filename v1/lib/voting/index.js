// v1/lib/voting/index.js
//
// Orchestrates the full vote-crediting pipeline out of the step modules
// in this folder. This is the only file voting.js needs to import from —
// each concern lives in its own file below so the flow can be read (and
// changed) one piece at a time, the same way v1/lib/ticket/index.js
// splits up ticket generation:
//
//   reference.js           — load Reference/{reference}, idempotency guard,
//                             stamp payment outcome (steps 1-3)
//   fees.js                 — royalty / service-fee math (mirrors
//                             booker/app/lib/poll-config.ts)
//   tie-breaker.js           — pure tie-breaker state machine (mirrors
//                             spotix-user/src/app/lib/tie-breaker.ts)
//   tie-breaker-vote.js       — ticks that state machine forward before
//                             crediting, and records this vote against an
//                             active/fptp round after crediting
//   allocate-vote.js          — credits the vote onto the poll doc, single
//                             or group shape (step 4)
//   entries.js                 — per-vote entry docs (step 4a)
//   daily-aggregation.js        — admin/votes/{pollId}/{date} (step 4b)
//   creator-stats.js             — user/{creatorId} revenue stats (step 4c)
//   analytics.js                  — admin/analytics daily/monthly/yearly (step 5)
//   wat-date.js                    — shared Africa/Lagos date-part helper
//
// Firestore layout (FLAT):
//   Reference/{reference}     ← payment reference (sptx-vt-{timestamp})
//                                (same collection ticket.js uses — capital "Reference")
//   voting/{pollId}           ← flat poll document, contains creatorId field
//   voting/{pollId}/entries/{reference} ← one doc per vote purchase (mirrors
//                                          events/{eventId}/attendees/{ticketId} in ticket.js)
//   votingHistory/{reference} ← global vote-purchase record (mirrors tickets/{ticketId})
//   admin/votes/{pollId}/{YYYY-MM-DD} ← daily aggregation, mirrors
//                                        admin/events/{eventId}/{date} (ticket.js Step 8)
//
// Poll types:
//   "single" → contestants[] (flat)
//   "group"  → categories[] tree with optional subcategories (nested)
//              Vote targets the leaf category identified by categoryId.
//
// Tie-breaker handling (see ./tie-breaker.js for the full state machine):
//   Before allocating, the poll's tieBreakers map is "ticked" forward — any
//   round whose timer has expired is resolved or rolled into the next round
//   right there, so the vote we're about to credit lands against current
//   state. After allocating, if this vote falls inside an active/fptp
//   tie-breaker round for its scope (the whole poll for "single", or the
//   leaf category for "group"), we record it as that round's first voter
//   and, if the round is in first-past-the-post mode, resolve the tie in
//   that contestant's favour immediately (via a transaction, so two
//   simultaneous "first" votes can't both win).

import { adminDb } from "../../firebase-admin.js";
import { invalidatePollCache } from "../../redis.js";

import { loadReference, isAlreadyProcessed, markReferenceStatus } from "./reference.js";
import { computeVoteFee } from "./fees.js";
import { tickPollTieBreakers, recordTieBreakerVote } from "./tie-breaker-vote.js";
import { allocateVote } from "./allocate-vote.js";
import { writeVoteEntries } from "./entries.js";
import { updateDailyVotes } from "./daily-aggregation.js";
import { updateCreatorStats } from "./creator-stats.js";
import { reportVotingAnalytics } from "./analytics.js";

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {"charge.success"|"charge.failed"} event
 * @param {object} data   — Paystack event data
 * @param {string} reference — sptx-vt-{timestamp}
 */
export async function processVotingCharge(fastify, event, data, reference) {
  const paymentStatus = event === "charge.success" ? "successful" : "failed";

  // ── Steps 1-2: load reference + idempotency guard ───────────────────────────
  const loaded = await loadReference(fastify, adminDb, reference);
  if (!loaded) return { status: "not_found", reference };
  const { referenceRef, refData } = loaded;

  if (isAlreadyProcessed(refData)) {
    fastify.log.info(`[voting] ${reference} already "${refData.status}" — skipped`);
    return { status: "already_processed", reference };
  }

  // ── Step 3: stamp payment outcome onto the reference ─────────────────────────
  await markReferenceStatus(fastify, referenceRef, reference, event, data, paymentStatus);

  if (paymentStatus === "failed") {
    return { status: "failed", reference };
  }

  // ── Step 4: allocate votes ────────────────────────────────────────────────────
  const {
    pollId,
    voteId,
    contestantId,
    categoryId,     // present for group polls (leaf category)
    voteCount,
    totalAmount,
    pollPrice,
  } = refData;

  const targetPollId = pollId ?? voteId ?? null;

  if (!targetPollId || !contestantId) {
    fastify.log.warn(`[voting] Missing pollId/contestantId on reference ${reference} — skipping allocation`);
    return { status: "successful_no_allocation", reference };
  }

  const pollRef = adminDb.collection("voting").doc(targetPollId);

  // Hoisted so Step 5 (admin analytics) can reuse the same fee computation.
  // Defaults are the "no poll found" fallback — treated as buyer-bears-burden
  // with zero fee so we never silently invent a royalty deduction.
  let buyerBearsBurden = true;
  let serviceFee       = 0;
  let netAmount        = Number(totalAmount ?? 0);
  let creatorId        = null;

  try {
    const pollSnap = await pollRef.get();

    if (!pollSnap.exists) {
      fastify.log.warn(`[voting] Poll ${targetPollId} not found`);
    } else {
      let pollData   = pollSnap.data();
      const pollType = pollData?.pollType ?? "single";
      const numVotes = Number(voteCount  ?? 1);
      const numAmt   = Number(totalAmount ?? 0);
      const baseAmt  = Number(pollPrice ?? 0) * numVotes;

      creatorId        = pollData?.creatorId ?? pollData?.organizerId ?? null;
      buyerBearsBurden = pollData?.buyerBearsBurden ?? true;

      // ── Tie-breaker: catch this scope up before crediting ─────────────────
      const scopeKey = pollType === "group" ? (categoryId ?? null) : "single";
      pollData = await tickPollTieBreakers(fastify, pollRef, pollData, targetPollId, new Date());
      const tbStateBeforeVote = scopeKey ? (pollData?.tieBreakers?.[scopeKey] ?? null) : null;

      const fee = computeVoteFee(buyerBearsBurden, numAmt, baseAmt);
      serviceFee = fee.serviceFee;
      netAmount  = fee.netAmount;

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
        // Tie-breaker context — null/false for an ordinary vote cast during
        // the poll's normal voting window.
        isTieBreakerVote: Boolean(tbStateBeforeVote && tbStateBeforeVote.contestantIds?.includes(contestantId)),
        tieBreakerRound:  tbStateBeforeVote && tbStateBeforeVote.contestantIds?.includes(contestantId) ? tbStateBeforeVote.round : null,
      };

      await allocateVote(fastify, pollRef, { pollData, pollType, contestantId, categoryId, numVotes, netAmount, targetPollId });

      // spotix-user's public voting-poll page caches this poll for up to
      // 15s (see voting-poll-lookup:* in voting-utils.ts) precisely
      // because there was no invalidation hook into this webhook — this
      // closes that gap, so a vote shows up on the page immediately
      // instead of waiting out the TTL. Never allowed to fail the
      // webhook: a stale page for up to 15s is fine, a failed payment
      // credit is not.
      try {
        await invalidatePollCache(targetPollId);
      } catch (err) {
        fastify.log.warn(`[voting] Cache invalidation failed for poll ${targetPollId} (non-blocking):`, err);
      }

      // ── Tie-breaker: record this vote against an active round
      await recordTieBreakerVote(fastify, pollRef, { scopeKey, tbStateBeforeVote, contestantId, reference, targetPollId });

      // ── Step 4a: scalable per-vote records 
      await writeVoteEntries(fastify, adminDb, pollRef, { voteEntry, reference, targetPollId, pollData, pollType, creatorId });

      // ── Step 4b: daily payout-eligible aggregation 
      await updateDailyVotes(fastify, adminDb, { targetPollId, pollData, numVotes, netAmount, reference });

      // ── Step 4c: creator stats 
      await updateCreatorStats(fastify, adminDb, { creatorId, netAmount, numVotes, targetPollId, reference });
    }
  } catch (err) {
    // Non-fatal — payment recorded; vote can be re-processed
    fastify.log.error(`[voting] Vote allocation failed for ${reference} (non-blocking):`, err);
  }

  // ── Step 5: admin analytics 
  await reportVotingAnalytics(fastify, adminDb, { voteCount, totalAmount, buyerBearsBurden, serviceFee, reference });

  return { status: "successful", reference };
}
