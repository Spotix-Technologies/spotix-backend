// v1/lib/free-ticket/verify-free-reference.js
//
// Step 1 of free-ticket generation: confirm the Reference doc exists and
// is actually a settled, zero-amount reference before anything else runs.
//
// This replaces the paid pipeline's verify-payment-status.js rather than
// reusing it. That module polls up to 3 times because a paid Reference's
// status is set asynchronously by Paystack's webhook, and the frontend's
// /v1/ticket fallback call can race ahead of it landing. A free Reference
// has no payment gateway in the loop at all — /api/v1/ref/free on the
// frontend writes status: "successful" synchronously, in the same request
// that creates the doc — so there's nothing to poll for.
//
// What this step guards against instead: a paid reference being run
// through the free pipeline (or a free one through the paid pipeline) by
// mistake — either by a stale/incorrect frontend call or a tampered
// request — since both pipelines write to the same top-level "Reference"
// collection and only the route (/v1/ticket vs /v1/ticket/free) tells them
// apart otherwise.

export async function verifyFreeReference(referenceDocRef) {
  const referenceDoc = await referenceDocRef.get();

  if (!referenceDoc.exists) {
    throw Object.assign(new Error("Free ticket reference not found"), { statusCode: 404 });
  }

  const paymentData = referenceDoc.data();

  if (Number(paymentData.totalAmount) !== 0 || Number(paymentData.ticketPrice) !== 0) {
    throw Object.assign(
      new Error("This reference is not a free-ticket reference."),
      { statusCode: 400 }
    );
  }

  if (paymentData.status !== "successful") {
    throw Object.assign(
      new Error("This free ticket reference has not been settled yet. Please try again shortly."),
      { statusCode: 400 }
    );
  }

  return paymentData;
}
