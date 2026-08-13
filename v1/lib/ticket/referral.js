// v1/lib/ticket/referral.js
//
// Step 7 of ticket generation: record usage for the referral doc
// (events/{eventId}/referrals/{code}) if the reference used one. Non-blocking.
//
// Usage entries live in a subcollection —
// events/{eventId}/referrals/{code}/usages/{ticketId} — one doc per ticket,
// rather than an array field on the referral doc itself. An array would
// grow unbounded on the parent doc (1MiB Firestore doc limit) and force a
// read-modify-write of the whole array on every purchase, which is exactly
// the kind of contention that causes lost updates when two buyers use the
// same referral code at once. A subcollection gives each ticket its own
// doc (no contention between concurrent purchases) and stays queryable
// (ordered, paginated, counted) without ever hitting a size ceiling.
// ticketId is used as the doc ID so re-running this step for the same
// reference (e.g. a retried webhook) is naturally idempotent — it
// overwrites the same doc instead of duplicating the entry.

import { FieldValue } from "firebase-admin/firestore";

export async function applyReferralUsage(
  fastify,
  adminDb,
  { paymentData, createdTicketIds, ticketSeats, buyerFullName, totalTicketCount, nowIso }
) {
  if (!paymentData.referralCode && !paymentData.referralName) return;

  try {
    const referralCode = paymentData.referralCode || paymentData.referralName;
    const referralDocRef = adminDb
      .collection("events")
      .doc(paymentData.eventId)
      .collection("referrals")
      .doc(referralCode);

    const referralDoc = await referralDocRef.get();

    if (referralDoc.exists) {
      const usagesRef = referralDocRef.collection("usages");
      const batch = adminDb.batch();

      createdTicketIds.forEach((tid, idx) => {
        batch.set(usagesRef.doc(tid), {
          name: buyerFullName || "Unknown",
          ticketType: ticketSeats[idx].type,
          ticketId: tid,
          purchaseDate: nowIso,
        });
      });

      // totalTickets stays a scalar counter on the parent doc — cheap to
      // read for dashboards/lists without having to count the subcollection.
      batch.update(referralDocRef, {
        totalTickets: FieldValue.increment(totalTicketCount),
      });

      await batch.commit();

      fastify.log.info(
        `[step:7] Referral "${referralCode}" — ${totalTicketCount} usage doc(s) written to usages`
      );
    }
  } catch (error) {
    fastify.log.error("[step:7] Referral update error (non-blocking):", error);
  }
}
