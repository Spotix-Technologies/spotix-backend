// v1/lib/voting/entries.js
//
// Step 4a: scalable per-vote records. Replaces the old unbounded
// voting/{pollId}.pollEntries array with two per-doc writes, mirroring
// ticket.js's tickets/{ticketId} + attendees pattern:
//
//   voting/{pollId}/entries/{reference}  — poll-scoped, powers the
//                                          booker's "Entries" tab
//   votingHistory/{reference}            — global record, one per vote
//                                          purchase, for cross-poll lookups
//
// Keyed by reference so this is naturally idempotent if ever re-run.

export async function writeVoteEntries(fastify, adminDb, pollRef, { voteEntry, reference, targetPollId, pollData, pollType, creatorId }) {
  try {
    await pollRef.collection("entries").doc(reference).set(voteEntry);

    await adminDb.collection("votingHistory").doc(reference).set({
      ...voteEntry,
      pollId:     targetPollId,
      pollName:   pollData?.pollName ?? "",
      pollType,
      creatorId,
    });

    fastify.log.info(`[voting] Entry recorded — voting/${targetPollId}/entries/${reference} + votingHistory/${reference}`);
  } catch (err) {
    fastify.log.error(`[voting] Failed to write vote entry docs for ${reference} (non-blocking):`, err);
  }
}
