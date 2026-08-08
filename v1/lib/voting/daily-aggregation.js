// v1/lib/voting/daily-aggregation.js
//
// Step 4b: admin/votes/{pollId}/{YYYY-MM-DD} — mirrors ticket.js's Step 8
// (admin/events/{eventId}/{date}, see lib/ticket/admin-sales.js).
// voteSales is NET (post-fee) since that is the only amount ever
// eligible for payout.

import { FieldValue } from "firebase-admin/firestore";
import { getWATDateParts } from "./wat-date.js";

export async function updateDailyVotes(fastify, adminDb, { targetPollId, pollData, numVotes, netAmount, reference }) {
  try {
    const { day } = getWATDateParts();
    const nowIso = new Date().toISOString();
    const dailyRef = adminDb
      .collection("admin")
      .doc("votes")
      .collection(targetPollId)
      .doc(day);

    const dailySnap = await dailyRef.get();
    if (!dailySnap.exists) {
      await dailyRef.set({
        pollName:     pollData?.pollName ?? "",
        voteCount:    numVotes,
        voteSales:    netAmount,
        lastVoteTime: nowIso,
        createdAt:    nowIso,
        lastUpdated:  nowIso,
      });
    } else {
      await dailyRef.update({
        voteCount:    FieldValue.increment(numVotes),
        voteSales:    FieldValue.increment(netAmount),
        lastVoteTime: nowIso,
        lastUpdated:  nowIso,
      });
    }

    fastify.log.info(`[voting] Daily votes updated for poll ${targetPollId} on ${day}`);
  } catch (err) {
    fastify.log.error(`[voting] Daily aggregation failed for ${reference} (non-blocking):`, err);
  }
}
