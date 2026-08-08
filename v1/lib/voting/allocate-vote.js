// v1/lib/voting/allocate-vote.js
//
// Step: credits a purchased vote onto the poll document itself —
//   single poll → voting/{pollId}.contestants[n].votes
//   group poll  → voting/{pollId}.categories tree → leaf by categoryId → contestant
// plus the poll-level pollCount/pollAmount increments that go with it.
//
// This is the money-safe step: it always credits, even if the leaf
// category can't be found (logs a warning instead — mirrors the rest of
// this pipeline's "never lose a payment over a data-shape surprise"
// posture). Tie-breaker eligibility is checked upstream (spotix-user's
// payref route, before payment) — by the time a vote reaches here it's
// credited unconditionally, the same way it always was pre-tie-breaker.

import { FieldValue } from "firebase-admin/firestore";

/**
 * Recursively walk the category tree and increment the target contestant's
 * votes inside the leaf category identified by targetCategoryId.
 *
 * Returns a NEW array (no mutation) and a flag indicating if the target was found.
 */
export function allocateGroupVote(categories, targetCategoryId, contestantId, numVotes) {
  let found = false;
  const updated = categories.map((cat) => {
    if (found) return cat;

    if (cat.categoryId === targetCategoryId) {
      // This is the leaf category — update the contestant
      found = true;
      return {
        ...cat,
        contestants: (cat.contestants ?? []).map((c) =>
          c.contestantId === contestantId
            ? { ...c, votes: (c.votes ?? 0) + numVotes }
            : c
        ),
      };
    }

    // Recurse into subcategories
    if (Array.isArray(cat.subcategories) && cat.subcategories.length > 0) {
      const subResult = allocateGroupVote(cat.subcategories, targetCategoryId, contestantId, numVotes);
      if (subResult.found) {
        found = true;
        return { ...cat, subcategories: subResult.updated };
      }
    }

    return cat;
  });

  return { updated, found };
}

/**
 * Credits `numVotes` to `contestantId` on the poll — dispatches to the
 * group (category-tree) or single (flat contestants[]) shape and writes
 * the pollCount/pollAmount increments in the same update.
 */
export async function allocateVote(fastify, pollRef, { pollData, pollType, contestantId, categoryId, numVotes, netAmount, targetPollId }) {
  if (pollType === "group" && categoryId) {
    // ── Group poll: find leaf category and update contestant ────────────
    const categories = pollData?.categories ?? [];
    const { updated: updatedCategories, found } = allocateGroupVote(
      categories, categoryId, contestantId, numVotes
    );

    if (!found) {
      fastify.log.warn(
        `[voting] [group] Category ${categoryId} not found in poll ${targetPollId} — vote entry recorded but no vote counted`
      );
    }

    await pollRef.update({
      categories:  updatedCategories,
      pollCount:   FieldValue.increment(numVotes),
      pollAmount:  FieldValue.increment(netAmount),
      updatedAt:   FieldValue.serverTimestamp(),
    });

    fastify.log.info(
      `[voting] [group] Allocated ${numVotes} vote(s) to ${contestantId} in category ${categoryId} on poll ${targetPollId}`
    );
  } else {
    // ── Single poll: update flat contestants array ──────────────────────
    const contestants        = pollData?.contestants ?? [];
    const updatedContestants = contestants.map((c) =>
      c.contestantId === contestantId
        ? { ...c, votes: (c.votes ?? 0) + numVotes }
        : c
    );

    await pollRef.update({
      contestants:  updatedContestants,
      pollCount:    FieldValue.increment(numVotes),
      pollAmount:   FieldValue.increment(netAmount),
      updatedAt:    FieldValue.serverTimestamp(),
    });

    fastify.log.info(
      `[voting] [single] Allocated ${numVotes} vote(s) to ${contestantId} on poll ${targetPollId}`
    );
  }
}
