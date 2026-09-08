// v1/lib/merch/reference.js
//
// Load the Reference/{reference} doc (shared with ticket/vote purchases —
// same "Reference" collection) and atomically claim the right to credit
// it exactly once. Mirrors v1/lib/voting/reference.js field-for-field,
// just keyed on `merchCredited`/`merchCreditLock` instead of
// `voteCredited`/`voteCreditLock`.
//
// A plain check-then-act guard isn't safe here: Paystack can redeliver
// the same webhook event, and a reconciliation pass can land on the same
// reference around the same time. Two concurrent callers could both read
// "not yet processed" before either has written back — and
// record_merch_order() increments merch_listings.total_sold and
// decrements quantity, so a race here means an order (and its stock
// decrement) gets applied twice. The guard is therefore a dedicated
// Firestore-transaction-claimed flag, never `status` alone.

/**
 * Fetches Reference/{reference}. Returns { referenceRef, refData } or
 * `null` if the doc doesn't exist (caller logs + returns "not_found").
 */
export async function loadReference(fastify, adminDb, reference) {
  const referenceRef = adminDb.collection("Reference").doc(reference);
  let refDoc;
  try {
    refDoc = await referenceRef.get();
  } catch (err) {
    fastify.log.error(`[merch] Firestore get failed for reference ${reference}:`, err);
    throw err;
  }

  if (!refDoc.exists) {
    fastify.log.warn(`[merch] Reference not found: ${reference}`);
    return null;
  }

  return { referenceRef, refData: refDoc.data() };
}

/**
 * True once this reference's order(s) have actually been credited (order
 * rows written, stock decremented, analytics logged). This — and only
 * this — is what should ever block re-processing.
 */
export function isAlreadyProcessed(refData) {
  return refData?.merchCredited === true;
}

/**
 * Atomically claims the right to run the crediting steps for this
 * reference — only ONE concurrent caller may hold the claim at a time.
 * Call this after the payment has been confirmed successful.
 *
 *   "already_credited" -> caller should return early, nothing to do
 *   "locked"            -> another request is mid-flight; caller should back off
 *   "claimed"            -> caller holds the lock, safe to run the order pipeline
 */
export async function claimMerchCreditLock(adminDb, referenceRef) {
  let claimResult = null;
  let refData = null;

  await adminDb.runTransaction(async (transaction) => {
    const doc = await transaction.get(referenceRef);
    if (!doc.exists) {
      throw Object.assign(new Error("Payment reference not found"), { statusCode: 404 });
    }

    const data = doc.data();
    refData = data;

    if (data.merchCredited) {
      claimResult = "already_credited";
      return;
    }

    if (data.merchCreditLock) {
      claimResult = "locked";
      return;
    }

    transaction.update(referenceRef, {
      merchCreditLock: true,
      merchCreditLockedAt: new Date().toISOString(),
    });
    claimResult = "claimed";
  });

  return { claimResult, refData };
}

/** Marks the reference as fully credited and releases the claim lock. */
export async function finalizeMerchCredit(fastify, referenceRef, reference, orderIds) {
  await referenceRef.update({
    merchCredited: true,
    merchCreditedAt: new Date().toISOString(),
    merchCreditLock: false,
    merchOrderIds: orderIds,
    updatedAt: new Date().toISOString(),
  });
  fastify.log.info(`[merch] Reference ${reference} merch credit finalized (${orderIds.length} order(s))`);
}

/**
 * Releases the claim lock WITHOUT marking the order credited — used when
 * crediting throws partway through, so a later retry (redelivered
 * webhook, manual reconciliation) isn't permanently blocked.
 */
export async function releaseMerchCreditLock(fastify, referenceRef, reference) {
  try {
    await referenceRef.update({ merchCreditLock: false });
  } catch (err) {
    fastify.log.error(`[merch] Failed to release credit lock for ${reference}:`, err);
  }
}

/**
 * Stamps the payment outcome onto the reference doc. Safe to call
 * repeatedly and regardless of credit state — this only ever touches
 * payment-status bookkeeping fields, never the merch-credit flag, so it
 * can never itself cause a double-credit.
 */
export async function markReferenceStatus(fastify, referenceRef, reference, event, data, paymentStatus) {
  const referenceUpdate = {
    status: paymentStatus,
    transactionType: "merch_purchase",
    updatedAt: new Date().toISOString(),
    paystackEvent: event,
    amount: data?.amount ?? null,
    currency: data?.currency ?? null,
    customer: {
      email: data?.customer?.email ?? null,
      customerCode: data?.customer?.customer_code ?? null,
    },
  };

  if (paymentStatus === "successful") {
    referenceUpdate.paymentCompletedAt = new Date().toISOString();
  } else {
    referenceUpdate.failureReason = data?.gateway_response ?? "Payment failed";
    referenceUpdate.paymentFailedAt = new Date().toISOString();
  }

  try {
    await referenceRef.update(referenceUpdate);
    fastify.log.info(`[merch] Reference ${reference} -> ${paymentStatus}`);
  } catch (err) {
    fastify.log.error(`[merch] Failed to update reference ${reference}:`, err);
    throw err;
  }
}
