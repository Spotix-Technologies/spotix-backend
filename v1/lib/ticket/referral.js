// v1/lib/ticket/referral.js
//
// Step 7 of ticket generation: append usage entries to the referral doc
// (events/{eventId}/referrals/{code}) if the reference used one. Non-blocking.

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
      const usageEntries = createdTicketIds.map((tid, idx) => ({
        name: buyerFullName || "Unknown",
        ticketType: ticketSeats[idx].type,
        ticketId: tid,
        purchaseDate: nowIso,
      }));

      await referralDocRef.update({
        usages: FieldValue.arrayUnion(...usageEntries),
        totalTickets: FieldValue.increment(totalTicketCount),
      });

      fastify.log.info(`[step:7] Referral "${referralCode}" updated with ${totalTicketCount} ticket(s)`);
    }
  } catch (error) {
    fastify.log.error("[step:7] Referral update error (non-blocking):", error);
  }
}
