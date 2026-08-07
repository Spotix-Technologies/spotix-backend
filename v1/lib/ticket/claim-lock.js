// v1/lib/ticket/claim-lock.js
//
// Guard step that runs right after payment is confirmed successful: only
// ONE concurrent request may actually process a given reference. Uses a
// Firestore transaction to atomically check ticketGenerated + processingLock
// and set processingLock before any generation work begins.
//
//   "already_generated" → caller should return early with existing ticket data
//   "locked"             → another request is mid-flight; caller should reject with 409
//   "claimed"             → caller holds the lock, safe to continue

/**
 * @param {FirebaseFirestore.DocumentReference} referenceDocRef
 * @returns {Promise<{ claimResult: "already_generated"|"locked"|"claimed", paymentData: FirebaseFirestore.DocumentData }>}
 */
export async function claimGenerationLock(adminDb, referenceDocRef, fallbackPaymentData) {
  let claimResult = null;
  let paymentData = fallbackPaymentData;

  await adminDb.runTransaction(async (transaction) => {
    const refDoc = await transaction.get(referenceDocRef);
    if (!refDoc.exists) throw Object.assign(new Error("Payment reference not found"), { statusCode: 404 });

    const data = refDoc.data();

    if (data.ticketGenerated) {
      claimResult = "already_generated";
      paymentData = data; // refresh to latest committed state
      return;
    }

    if (data.processingLock) {
      claimResult = "locked";
      return;
    }

    // Claim the lock — concurrent transactions on the same ref will now see locked=true
    transaction.update(referenceDocRef, {
      processingLock: true,
      processingLockedAt: new Date().toISOString(),
    });
    claimResult = "claimed";
  });

  return { claimResult, paymentData };
}

/**
 * Shape returned when generateTickets() is called again for a reference
 * that already completed generation on an earlier call (webhook + fallback
 * race, retried request, etc).
 */
export function buildAlreadyGeneratedResult(paymentData) {
  const isGuest = !paymentData.userId;
  return {
    alreadyGenerated: true,
    ticketIds: paymentData.generatedTicketIds || [],
    totalTickets: paymentData.totalTicketsGenerated || 0,
    eventId: paymentData.eventId,
    eventName: paymentData.eventName,
    totalAmount: paymentData.totalAmount || 0,
    buyerInfo: {
      fullName: paymentData.userFullName || "Valued Customer",
      email: paymentData.userEmail || paymentData.guestEmail || "",
      isGuest,
    },
    eventDetails: {
      eventVenue: paymentData.eventVenue || null,
      eventType: paymentData.eventType || null,
      eventDate: paymentData.eventDate || null,
      eventEndDate: paymentData.eventEndDate || null,
      eventStart: paymentData.eventStart || null,
      eventEnd: paymentData.eventEnd || null,
      bookerName: paymentData.bookerName || null,
      bookerEmail: paymentData.bookerEmail || null,
    },
    discountApplied: !!paymentData.discountCode,
    referralUsed: !!paymentData.referralCode,
  };
}
