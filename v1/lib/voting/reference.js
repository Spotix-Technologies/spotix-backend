// v1/lib/voting/reference.js
//
// Steps 1-3 of vote crediting: load the Reference/{reference} doc (shared
// with ticket purchases — same collection, capital "Reference"), guard
// against re-processing an already-settled reference, and stamp the
// payment outcome onto it.

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

/** True if this reference has already been settled (successful or failed). */
export function isAlreadyProcessed(refData) {
  return refData.status === "successful" || refData.status === "failed";
}

/**
 * Stamps the payment outcome onto the reference doc. Throws on write
 * failure (mirrors the original behaviour — a failed reference update is
 * fatal, unlike everything downstream of it).
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
