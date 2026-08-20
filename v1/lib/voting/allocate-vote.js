// v1/lib/voting/allocate-vote.js
//
// Step: credits a purchased vote onto the poll —
//   single poll → voting/{pollId}.contestants[n].votes
//   group poll  → voting/{pollId}/categories/{categoryId}.contestants[n].votes
//                 (own document per category — see spotix-booker's
//                 app/lib/poll-categories.ts for the schema and why it
//                 stopped being one big nested array on the poll doc)
// plus the poll-level pollCount/pollAmount increments that go with it.
//
// This is the money-safe step: it always credits, even if the target
// contestant/category can't be found (logs a warning instead — mirrors
// the rest of this pipeline's "never lose a payment over a data-shape
// surprise" posture). Tie-breaker eligibility is checked upstream
// (spotix-vote/spotix-user's payref route, before payment) — by the time
// a vote reaches here it's credited unconditionally, the same way it
// always was pre-tie-breaker.
//
// Group-poll history: this used to read the ENTIRE nested category tree
// off the poll doc, patch one contestant deep inside it in memory, and
// write the WHOLE tree back on every single vote. Two problems with
// that, both now fixed by targeting the leaf category's own document:
//   1. A poll with ~200 category nodes could carry ~2000+ array elements
//      once contestants were counted too — past what the Firestore
//      console would even render, and a genuinely large document to
//      rewrite in full on every vote.
//   2. Two votes landing on DIFFERENT categories of the same poll at
//      close to the same moment would race: both read the same
//      pre-vote tree, both write their own patched copy back, and
//      whichever write lands second silently discards the first vote's
//      change. Scoping each vote down to just its own leaf category
//      document removes that race entirely for anything migrated to
//      the new schema — votes on different categories no longer touch
//      the same document at all, and votes on the SAME category are
//      still safe because the read-modify-write below runs inside a
//      Firestore transaction.

import { FieldValue } from "firebase-admin/firestore";
import { invalidateCategoryTreeCache } from "../../redis.js";

/**
 * LEGACY PATH ONLY — recursively walks a whole-tree `categories` array
 * (the old poll.categories field) and increments the target contestant's
 * votes inside the leaf category identified by targetCategoryId.
 *
 * Used only for a group poll that hasn't been migrated to the
 * categories subcollection yet (see allocateVote below) — once a poll
 * is migrated (by editing it in spotix-booker, or via
 * /admin/migrate-categories), this function is never called for it
 * again. Kept around purely for backward compatibility during rollout.
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
 * Credits `numVotes` to `contestantId` inside the leaf category document
 * `voting/{pollId}/categories/{categoryId}`, inside a transaction so two
 * votes landing on the SAME category at the same moment can't clobber
 * each other the way the old whole-tree write could.
 *
 * Returns true if the contestant was found and credited.
 */
async function creditContestantInCategoryDoc(adminDb, categoryDocRef, contestantId, numVotes) {
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(categoryDocRef);
    if (!snap.exists) return false;

    const data = snap.data();
    const contestants = data.contestants ?? [];
    let matched = false;
    const updatedContestants = contestants.map((c) => {
      if (c.contestantId !== contestantId) return c;
      matched = true;
      return { ...c, votes: (c.votes ?? 0) + numVotes };
    });

    if (!matched) return false;

    tx.update(categoryDocRef, {
      contestants: updatedContestants,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

/**
 * Credits `numVotes` to `contestantId` on the poll — dispatches to the
 * group (category subcollection, or legacy tree) or single (flat
 * contestants[]) shape and writes the pollCount/pollAmount increments in
 * the same step.
 */
export async function allocateVote(fastify, pollRef, { adminDb, pollData, pollType, contestantId, categoryId, numVotes, netAmount, targetPollId }) {
  if (pollType === "group" && categoryId) {
    const categoriesRef = pollRef.collection("categories");
    const categoryDocRef = categoriesRef.doc(categoryId);
    const categorySnap = await categoryDocRef.get();

    let found;

    if (categorySnap.exists) {
      // ── Migrated schema: category is its own document ─────────────────
      found = await creditContestantInCategoryDoc(adminDb, categoryDocRef, contestantId, numVotes);
      if (!found) {
        fastify.log.warn(
          `[voting] [group] Contestant ${contestantId} not found in category ${categoryId} on poll ${targetPollId} — vote entry recorded but no vote counted`
        );
      } else {
        fastify.log.info(
          `[voting] [group] Allocated ${numVotes} vote(s) to ${contestantId} in category ${categoryId} on poll ${targetPollId}`
        );
      }
    } else {
      // categoryDocRef doesn't exist — could mean either (a) this poll
      // hasn't been migrated to the subcollection yet (legacy array
      // still on the poll doc), or (b) it HAS been migrated and this
      // categoryId is just wrong/stale. Tell those apart before falling
      // back, so (b) doesn't silently no-op against an empty legacy
      // array — that would look identical to (a) in the logs otherwise.
      const anyCategorySnap = await categoriesRef.limit(1).get();

      if (anyCategorySnap.empty) {
        // (a) Legacy poll — whole-tree read/patch/write, same as before
        // this change. Goes away entirely once this poll is migrated
        // (spotix-booker's /admin/migrate-categories, or its next edit).
        const categories = pollData?.categories ?? [];
        const { updated: updatedCategories, found: legacyFound } = allocateGroupVote(
          categories, categoryId, contestantId, numVotes
        );
        found = legacyFound;

        if (!found) {
          fastify.log.warn(
            `[voting] [group][legacy] Category ${categoryId} not found in poll ${targetPollId} — vote entry recorded but no vote counted`
          );
        }

        await pollRef.update({
          categories: updatedCategories,
          updatedAt: FieldValue.serverTimestamp(),
        });

        if (found) {
          fastify.log.info(
            `[voting] [group][legacy] Allocated ${numVotes} vote(s) to ${contestantId} in category ${categoryId} on poll ${targetPollId}`
          );
        }
      } else {
        // (b) Migrated poll, but this categoryId doesn't exist in it.
        found = false;
        fastify.log.warn(
          `[voting] [group] Category ${categoryId} does not exist on migrated poll ${targetPollId} — vote entry recorded but no vote counted`
        );
      }
    }

    await pollRef.update({
      pollCount:  FieldValue.increment(numVotes),
      pollAmount: FieldValue.increment(netAmount),
      updatedAt:  FieldValue.serverTimestamp(),
    });

    // Non-blocking: a payment must never fail to credit over a cache
    // problem. Covers both branches above — a stale cached tree is
    // stale whether the underlying write just happened in the
    // subcollection or (temporarily, pre-migration) the legacy array.
    try {
      await invalidateCategoryTreeCache(targetPollId);
    } catch (err) {
      fastify.log.warn(`[voting] Category cache invalidation failed for poll ${targetPollId} (non-blocking):`, err);
    }
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
