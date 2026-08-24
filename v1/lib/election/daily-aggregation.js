// v1/lib/election/daily-aggregation.js
//
// Step 4a: admin/elections/{electionId}/{YYYY-MM-DD} — mirrors
// v1/lib/voting/daily-aggregation.js (admin/votes/{pollId}/{date}), but
// with field names matching what spotix-booker's PayoutTab.tsx already
// expects (see its DailyTotal interface: { date, totalAmount, formCount }
// and the payout route reading admin/elections/{electionId}/{date}) —
// this is the ONLY producer of that doc, so the shape here IS the
// contract.
//
// totalAmount is NET (formFee, i.e. post-service-fee) since that's the
// only amount ever eligible for payout — same convention as
// voteSales/ticketSales elsewhere.

import { FieldValue } from "firebase-admin/firestore";
import { getWATDateParts } from "./wat-date.js";

export async function updateDailyElectionForms(fastify, adminDb, { electionId, electionName, netAmount, reference }) {
  try {
    const { day } = getWATDateParts();
    const nowIso = new Date().toISOString();
    const dailyRef = adminDb
      .collection("admin")
      .doc("elections")
      .collection(electionId)
      .doc(day);

    const dailySnap = await dailyRef.get();
    if (!dailySnap.exists) {
      await dailyRef.set({
        electionName,
        formCount:       1,
        totalAmount:     netAmount,
        lastFormTime:    nowIso,
        createdAt:       nowIso,
        lastUpdated:     nowIso,
      });
    } else {
      await dailyRef.update({
        formCount:    FieldValue.increment(1),
        totalAmount:  FieldValue.increment(netAmount),
        lastFormTime: nowIso,
        lastUpdated:  nowIso,
      });
    }

    fastify.log.info(`[election] Daily form totals updated for election ${electionId} on ${day}`);
  } catch (err) {
    fastify.log.error(`[election] Daily aggregation failed for ${reference} (non-blocking):`, err);
  }
}
