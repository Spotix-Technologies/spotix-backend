// v1/lib/ticket/verify-payment-status.js
//
// Step 1 of ticket generation: confirm the Reference doc reports a
// successful payment before anything else happens. Polls briefly because
// the webhook and the frontend's fallback /v1/ticket call can race —
// Paystack's webhook may not have landed yet when the fallback fires.

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {FirebaseFirestore.DocumentReference} referenceDocRef
 * @returns {Promise<FirebaseFirestore.DocumentData>} the Reference doc data once status === "successful"
 */
export async function verifyPaymentStatus(fastify, referenceDocRef) {
  let paymentData = null;
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    const referenceDoc = await referenceDocRef.get();

    if (!referenceDoc.exists) {
      throw Object.assign(new Error("Payment reference not found"), { statusCode: 404 });
    }

    paymentData = referenceDoc.data();

    if (paymentData.status === "successful") {
      return paymentData;
    } else if (paymentData.status === "failed") {
      // Prefer Paystack's actual gateway response text (captured on the
      // Reference doc as failureReason by webhook.js / verify-payment.js)
      // over a generic message — the frontend matches specific phrases
      // like "Incorrect amount sent" against this to show a more useful
      // state than a blanket failure.
      throw Object.assign(
        new Error(
          paymentData.failureReason ||
            "Payment verification failed. Please try again or contact support."
        ),
        { statusCode: 400 }
      );
    } else if (paymentData.status === "pending") {
      attempts++;
      if (attempts < maxAttempts) {
        fastify.log.info(`[step:1] Payment pending, retrying (${attempts}/${maxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        throw Object.assign(
          new Error("Payment is still being processed. Please try again in a few moments."),
          { statusCode: 400 }
        );
      }
    }
  }

  return paymentData;
}
