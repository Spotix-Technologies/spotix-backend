// v1/lib/voting/reference.js
//
// Steps 1-3 of vote crediting: load the Reference/{reference} doc (shared
// with ticket purchases — same collection, capital "Reference"), and
// atomically claim the right to credit it exactly once.
//
// This mirrors v1/lib/ticket/claim-lock.js on purpose. A plain
// check-then-act guard ("if status is already successful/failed, skip")
// is NOT safe here: Paystack can (and does) redeliver the same webhook
// event, and the reconciliation path in verify-payment.js can land on the
// same reference around the same time. Two concurrent callers can both
// read "not yet processed" before either has written back, and
// allocate-vote.js uses FieldValue.increment() — so a race there means a
// vote (and its payout-eligible revenue) gets credited twice.
//
// The guard is therefore keyed on a dedicated `voteCredited` flag,
// claimed inside a Firestore transaction, never on `status` alone. That
// also makes the "pending now, successful later" case work correctly: a
// reference that was first seen pending (or briefly marked failed by a
// stale/premature webhook) can still be credited the moment something
// confirms it really succeeded — voteCredited is the only thing that
// permanently closes the door.

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
    fastify.log.error(`[voting] Firestore get failed for reference ${reference}:`, err);
    throw err;
  }

  if (!refDoc.exists) {
    fastify.log.warn(`[voting] Reference not found: ${reference}`);
    return null;
  }

  return { referenceRef, refData: refDoc.data() };
}

/**
 * True once this reference's vote has actually been credited onto the
 * poll (ticket/profit-equivalent step for voting). This — and only this
 * — is what should ever block re-processing.
 */
export function isAlreadyProcessed(refData) {
  return refData?.voteCredited === true;
}

/**
 * Atomically claims the right to run the crediting steps for this
 * reference — only ONE concurrent caller may hold the claim at a time.
 * Call this after the payment has been confirmed successful.
 *
 *   "already_credited" → caller should return early, nothing to do
 *   "locked"            → another request is mid-flight; caller should back off
 *   "claimed"            → caller holds the lock, safe to run allocateVote etc.
 */
export async function claimVoteCreditLock(adminDb, referenceRef) {
  let claimResult = null;
  let refData = null;

  await adminDb.runTransaction(async (transaction) => {
    const doc = await transaction.get(referenceRef);
    if (!doc.exists) {
      throw Object.assign(new Error("Payment reference not found"), { statusCode: 404 });
    }

    const data = doc.data();
    refData = data;

    if (data.voteCredited) {
      claimResult = "already_credited";
      return;
    }

    if (data.voteCreditLock) {
      claimResult = "locked";
      return;
    }

    // Claim the lock — concurrent transactions on the same ref will now see locked=true
    transaction.update(referenceRef, {
      voteCreditLock: true,
      voteCreditLockedAt: new Date().toISOString(),
    });
    claimResult = "claimed";
  });

  return { claimResult, refData };
}

/** Marks the reference as fully credited and releases the claim lock. */
export async function finalizeVoteCredit(fastify, referenceRef, reference) {
  await referenceRef.update({
    voteCredited: true,
    voteCreditedAt: new Date().toISOString(),
    voteCreditLock: false,
    updatedAt: new Date().toISOString(),
  });
  fastify.log.info(`[voting] Reference ${reference} vote credit finalized`);
}

/**
 * Releases the claim lock WITHOUT marking the vote credited — used when
 * crediting throws partway through, so a later retry (redelivered
 * webhook, manual reconciliation) isn't permanently blocked.
 */
export async function releaseVoteCreditLock(fastify, referenceRef, reference) {
  try {
    await referenceRef.update({ voteCreditLock: false });
  } catch (err) {
    fastify.log.error(`[voting] Failed to release credit lock for ${reference}:`, err);
  }
}

/**
 * Stamps the payment outcome onto the reference doc. Safe to call
 * repeatedly and regardless of credit state — this only ever touches
 * payment-status bookkeeping fields, never the vote-credit flag, so it
 * can never itself cause a double-credit.
 */
export async function markReferenceStatus(fastify, referenceRef, reference, event, data, paymentStatus) {
  const referenceUpdate = {
    status:        paymentStatus,
    updatedAt:     new Date().toISOString(),
    paystackEvent: event,
    amount:        data?.amount   ?? null,
    currency:      data?.currency ?? null,
    customer: {
      email:        data?.customer?.email         ?? null,
      customerCode: data?.customer?.customer_code ?? null,
    },
  };

  if (paymentStatus === "successful") {
    referenceUpdate.paymentCompletedAt = new Date().toISOString();
  } else {
    referenceUpdate.failureReason   = data?.gateway_response ?? "Payment failed";
    referenceUpdate.paymentFailedAt = new Date().toISOString();
  }

  try {
    await referenceRef.update(referenceUpdate);
    fastify.log.info(`[voting] Reference ${reference} → ${paymentStatus}`);
  } catch (err) {
    fastify.log.error(`[voting] Failed to update reference ${reference}:`, err);
    throw err;
  }
}
