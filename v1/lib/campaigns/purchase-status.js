// v1/lib/campaigns/purchase-status.js
//
// One status lookup for BOTH kinds of credit purchase (email + SMS), keyed
// purely by payment reference. This is what makes the booker's
// "?ref=… in the URL" receipt work: a buyer who leaves the browser to finish
// paying in their bank app comes back to a reloaded page, and the page only
// has the reference to go on.
//
// If the reference is still pending we ask Paystack right now (the same
// idempotent fulfilment the webhook uses), so a payment that completed while
// the buyer was away shows up as successful immediately, not after a webhook.

import { adminDb } from "../../firebase-admin.js";
import { verifyAndFulfillPurchase } from "./billing.js";
import { verifyAndFulfillSmsPurchase, SMS_TRANSACTION_TYPE } from "../sms/billing.js";

const REFERENCE_COLLECTION = adminDb.collection("Reference");
const EMAIL_TRANSACTION_TYPE = "email_credit_purchase";

function shape(refData) {
  const kind = refData.transactionType === SMS_TRANSACTION_TYPE ? "sms" : "email";
  let status = "pending";
  if (refData.creditsIssued || refData.status === "successful") status = "successful";
  else if (refData.status === "failed") status = "failed";

  return {
    kind,
    status,
    reference: refData.reference,
    creditAmount: refData.creditAmount,
    price: refData.price,
    discountAmount: refData.discountAmount || 0,
    discountPercent: refData.discountPercent || 0,
    vat: refData.paystackFee ?? 0,
    totalAmount: refData.totalAmount,
    eventId: refData.eventId || null,
    createdAt: refData.createdAt,
    paymentCompletedAt: refData.paymentCompletedAt || null,
  };
}

/**
 * @returns {Promise<null | ReturnType<typeof shape>>} null when the reference
 *   doesn't exist or doesn't belong to this organizer (indistinguishable on
 *   purpose — no probing other people's references).
 */
export async function getPurchaseStatus(reference, organizerId) {
  const refDoc = REFERENCE_COLLECTION.doc(reference);
  let snap = await refDoc.get();
  if (!snap.exists) return null;

  let data = snap.data();
  const type = data.transactionType;
  if (type !== EMAIL_TRANSACTION_TYPE && type !== SMS_TRANSACTION_TYPE) return null;
  if (data.userId !== organizerId) return null;

  if (!data.creditsIssued) {
    // Pending — or marked failed by something that couldn't have known the
    // buyer was still mid-payment. Ask Paystack; fulfilment is idempotent.
    try {
      if (type === SMS_TRANSACTION_TYPE) await verifyAndFulfillSmsPurchase(reference);
      else await verifyAndFulfillPurchase(reference);
    } catch (err) {
      console.error(`[purchase-status] verify failed for ${reference}:`, err?.message || err);
    }
    snap = await refDoc.get();
    data = snap.data();
  }

  return shape(data);
}
