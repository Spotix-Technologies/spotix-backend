/**
 * scripts/migrate-poll-entries.js
 *
 * One-time backfill: copies every entry in the legacy
 *   voting/{pollId}.pollEntries[]
 * array into the new scalable layout used by v1/voting.js:
 *   voting/{pollId}/entries/{reference}
 *   votingHistory/{reference}
 *
 * Safe to re-run — every write is a `.set()` keyed by the entry's own
 * `reference` field, so re-running just overwrites the same docs with the
 * same data (no duplication).
 *
 * The old `pollEntries` array on the poll document is left untouched by
 * this script — it is NOT deleted. Once you've verified the new
 * subcollections/collection look right in the console, you can drop the
 * `pollEntries` field from `voting/{pollId}` docs separately (a plain
 * Firestore field-delete migration, kept out of this script deliberately
 * so a bad run here can't destroy the only copy of the historical data).
 *
 * Usage:
 *   node scripts/migrate-poll-entries.js            # migrate every poll
 *   node scripts/migrate-poll-entries.js <pollId>    # migrate a single poll
 *
 * Requires the same env vars as the rest of the backend
 * (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).
 */

import { adminDb } from "./v1/firebase-admin.js"

function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (typeof value === "object" && "_seconds" in value) {
    return new Date(value._seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

async function migratePoll(pollId, pollData, stats) {
  const entries = Array.isArray(pollData.pollEntries) ? pollData.pollEntries : [];
  if (entries.length === 0) return;

  const pollRef = adminDb.collection("voting").doc(pollId);
  const creatorId = pollData.creatorId ?? pollData.organizerId ?? null;
  const pollType = pollData.pollType ?? "single";

  // Firestore batches cap at 500 writes; each entry needs 2 writes
  // (entries subdoc + votingHistory doc), so chunk at 200 entries/batch.
  const CHUNK_SIZE = 200;

  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const batch = adminDb.batch();

    for (const entry of chunk) {
      const reference = entry.reference;
      if (!reference) {
        stats.skippedNoReference += 1;
        continue;
      }

      const normalized = {
        ...entry,
        date: normalizeDate(entry.date),
      };

      const entryRef = pollRef.collection("entries").doc(reference);
      batch.set(entryRef, normalized, { merge: true });

      const historyRef = adminDb.collection("votingHistory").doc(reference);
      batch.set(
        historyRef,
        {
          ...normalized,
          pollId,
          pollName: pollData.pollName ?? "",
          pollType,
          creatorId,
        },
        { merge: true }
      );

      stats.migrated += 1;
    }

    await batch.commit();
  }

  console.log(`  voting/${pollId}: migrated ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
}

async function main() {
  const onlyPollId = process.argv[2] || null;
  const stats = { pollsScanned: 0, migrated: 0, skippedNoReference: 0 };

  console.log(onlyPollId
    ? `Migrating pollEntries for single poll: ${onlyPollId}`
    : "Migrating pollEntries for ALL polls in voting/ ..."
  );

  if (onlyPollId) {
    const snap = await adminDb.collection("voting").doc(onlyPollId).get();
    if (!snap.exists) {
      console.error(`voting/${onlyPollId} not found.`);
      process.exit(1);
    }
    stats.pollsScanned = 1;
    await migratePoll(onlyPollId, snap.data(), stats);
  } else {
    const snap = await adminDb.collection("voting").get();
    for (const doc of snap.docs) {
      // Skip legacy nested-owner docs (voting/{userId}) which don't have pollName
      const data = doc.data();
      if (!data.pollName) continue;
      stats.pollsScanned += 1;
      await migratePoll(doc.id, data, stats);
    }
  }

  console.log("\nDone.");
  console.log(`  Polls scanned:            ${stats.pollsScanned}`);
  console.log(`  Entries migrated:         ${stats.migrated}`);
  console.log(`  Skipped (no reference):   ${stats.skippedNoReference}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
