// v1/lib/voting/tie-breaker-vote.js
//
// Wires the pure state machine in ./tie-breaker.js into the actual vote
// crediting flow. Two steps, called from either side of allocate-vote.js:
//
//   tickPollTieBreakers()  — BEFORE crediting: rolls any expired round
//                             forward (resolves it, opens the next round,
//                             or drops to first-past-the-post) so the vote
//                             about to be credited lands against current
//                             state. Persists the change if anything moved.
//
//   recordTieBreakerVote() — AFTER crediting: if the vote fell inside an
//                             active/fptp round for its scope, note it as
//                             that round's first voter and, if the round
//                             is in first-past-the-post mode, resolve the
//                             tie in that contestant's favour immediately
//                             (inside a transaction, so two simultaneous
//                             "first" votes can't both win).

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../firebase-admin.js";
import { tickTieBreakers } from "./tie-breaker.js";

/**
 * Ticks the poll's tieBreakers map forward to `now` and persists the
 * change if one happened. Returns the (possibly updated) pollData so the
 * caller always works off current state.
 */
export async function tickPollTieBreakers(fastify, pollRef, pollData, targetPollId, now = new Date()) {
  try {
    const { tieBreakers: tickedTieBreakers, changed } = tickTieBreakers(pollData, now);
    if (!changed) return pollData;

    await pollRef.update({ tieBreakers: tickedTieBreakers, updatedAt: FieldValue.serverTimestamp() });
    fastify.log.info(`[voting] Tie-breaker state advanced for poll ${targetPollId}`);
    return { ...pollData, tieBreakers: tickedTieBreakers };
  } catch (err) {
    fastify.log.error(`[voting] Tie-breaker tick failed for poll ${targetPollId} (non-blocking):`, err);
    return pollData;
  }
}

/**
 * Records a credited vote against its scope's tie-breaker round, if it
 * falls inside one. No-op if `tbStateBeforeVote` is null or the
 * contestant isn't part of that round's contestantIds.
 */
export async function recordTieBreakerVote(fastify, pollRef, { scopeKey, tbStateBeforeVote, contestantId, reference, targetPollId }) {
  if (!tbStateBeforeVote || !tbStateBeforeVote.contestantIds?.includes(contestantId)) return;

  try {
    if (tbStateBeforeVote.status === "fptp") {
      // First-past-the-post: whoever's vote lands first, wins — resolved
      // inside a transaction so two near-simultaneous "first" votes
      // can't both claim the win.
      await adminDb.runTransaction(async (tx) => {
        const freshSnap = await tx.get(pollRef);
        if (!freshSnap.exists) return;
        const freshData = freshSnap.data();
        const freshTb   = freshData?.tieBreakers?.[scopeKey];
        if (!freshTb || freshTb.status !== "fptp" || freshTb.winnerId) return; // already resolved

        tx.update(pollRef, {
          [`tieBreakers.${scopeKey}.winnerId`]:       contestantId,
          [`tieBreakers.${scopeKey}.status`]:         "resolved",
          [`tieBreakers.${scopeKey}.resolvedMethod`]: "fptp",
          [`tieBreakers.${scopeKey}.resolvedAt`]:     new Date().toISOString(),
          [`tieBreakers.${scopeKey}.firstVoterContestantId`]: freshTb.firstVoterContestantId ?? contestantId,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      fastify.log.info(`[voting] Tie-breaker resolved first-past-the-post — ${contestantId} wins scope ${scopeKey} on poll ${targetPollId}`);
    } else if (!tbStateBeforeVote.firstVoterContestantId) {
      // Active (timed) round — just note who voted first; doesn't
      // decide the round on its own, the round-end tick does that.
      await pollRef.update({
        [`tieBreakers.${scopeKey}.firstVoterContestantId`]: contestantId,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    fastify.log.error(`[voting] Tie-breaker vote recording failed for ${reference} (non-blocking):`, err);
  }
}
