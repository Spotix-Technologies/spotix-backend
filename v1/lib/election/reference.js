// v1/lib/election/reference.js
//
// Steps 1-3 of election-candidate crediting: load the Reference/{reference}
// doc (same collection ticket.js and voting.js use — capital "Reference"),
// and atomically claim the right to credit it exactly once.
//
// Mirrors v1/lib/voting/reference.js almost exactly — same reasoning
// applies here: Paystack can redeliver the same webhook event, so a
// plain check-then-act guard isn't safe. The candidate insert in
// allocate-candidate.js has a unique constraint (office_id, email) as a
// second line of defense, but the lock is what stops two concurrent
// callers from racing the daily/analytics FieldValue.increment() calls,
// which a unique constraint alone wouldn't catch.
//
// The guard is keyed on a dedicated `candidateCredited` flag, claimed
// inside a Firestore transaction, never on `status` alone — so a
// reference first seen "pending" (or briefly "failed" from a
// stale/premature webhook) can still be credited the moment something
// confirms it really succeeded.

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
    fastify.log.error(`[election] Firestore get failed for reference ${reference}:`, err);
    throw err;
  }

  if (!refDoc.exists) {
    fastify.log.warn(`[election] Reference not found: ${reference}`);
    return null;
  }

  return { referenceRef, refData: refDoc.data() };
}

/**
 * True once this reference's candidate has actually been inserted into
 * election_candidates. This — and only this — is what should ever
 * block re-processing.
 */
export function isAlreadyProcessed(refData) {
  return refData?.candidateCredited === true;
}

/**
 * Atomically claims the right to run the crediting steps for this
 * reference — only ONE concurrent caller may hold the claim at a time.
 * Call this after the payment has been confirmed successful.
 *
 *   "already_credited" → caller should return early, nothing to do
 *   "locked"            → another request is mid-flight; caller should back off
 *   "claimed"            → caller holds the lock, safe to run allocateCandidate etc.
 */
export async function claimCandidateCreditLock(adminDb, referenceRef) {
  let claimResult = null;
  let refData = null;

  await adminDb.runTransaction(async (transaction) => {
    const doc = await transaction.get(referenceRef);
    if (!doc.exists) {
      throw Object.assign(new Error("Payment reference not found"), { statusCode: 404 });
    }

    const data = doc.data();
    refData = data;

    if (data.candidateCredited) {
      claimResult = "already_credited";
      return;
    }

    if (data.candidateCreditLock) {
      claimResult = "locked";
      return;
    }

    transaction.update(referenceRef, {
      candidateCreditLock: true,
      candidateCreditLockedAt: new Date().toISOString(),
    });
    claimResult = "claimed";
  });

  return { claimResult, refData };
}

/** Marks the reference as fully credited and releases the claim lock. */
export async function finalizeCandidateCredit(fastify, referenceRef, reference, candidateId) {
  await referenceRef.update({
    candidateCredited: true,
    candidateCreditedAt: new Date().toISOString(),
    candidateCreditLock: false,
    candidateId: candidateId ?? null,
    updatedAt: new Date().toISOString(),
  });
  fastify.log.info(`[election] Reference ${reference} candidate credit finalized`);
}

/**
 * Releases the claim lock WITHOUT marking the candidate credited — used
 * when crediting throws partway through, so a later retry (redelivered
 * webhook, manual reconciliation) isn't permanently blocked.
 */
export async function releaseCandidateCreditLock(fastify, referenceRef, reference) {
  try {
    await referenceRef.update({ candidateCreditLock: false });
  } catch (err) {
    fastify.log.error(`[election] Failed to release credit lock for ${reference}:`, err);
  }
}

/**
 * Stamps the payment outcome onto the reference doc. Safe to call
 * repeatedly and regardless of credit state — this only ever touches
 * payment-status bookkeeping fields, never the candidate-credit flag,
 * so it can never itself cause a double-credit.
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
    fastify.log.info(`[election] Reference ${reference} → ${paymentStatus}`);
  } catch (err) {
    fastify.log.error(`[election] Failed to update reference ${reference}:`, err);
    throw err;
  }
}
