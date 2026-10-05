// v1/lib/sms/billing.js
//
// SMS credit purchases. Same shape as v1/lib/campaigns/billing.js (email
// credits): a pending `Reference` doc is created up front (reference id
// `SPTX-SMS-{timestamp}-{2 letters}`, mirroring spotix-user's create-pay-ref),
// payment is verified server-side against Paystack, and fulfilment is
// idempotent — the client's /verify call, the status poll on the receipt page
// and the Paystack webhook can all call verifyAndFulfillSmsPurchase for the
// same reference and credits are granted exactly once.
//
// What's stored on the reference is frozen at purchase time: a later change to
// the tiers or to a discount code never rewrites what this purchase cost.

import crypto from "node:crypto";
import { adminDb } from "../../firebase-admin.js";
import { quoteSmsPurchase } from "./pricing.js";
import { grantSmsCredits } from "./credits.js";
import { verifyWithPaystack, classifyPaystackStatus } from "../campaigns/paystack-verify.js";
import { sendCreditPurchaseConfirmationEmail } from "../campaigns/purchase-email.js";

const REFERENCE_COLLECTION = adminDb.collection("Reference");
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const SMS_TRANSACTION_TYPE = "sms_credit_purchase";

function randomLetters(length = 2) {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHA[crypto.randomInt(ALPHA.length)];
  return out;
}

function buildSmsReference(timestamp) {
  return `SPTX-SMS-${timestamp}-${randomLetters(2)}`;
}

/** Creates the pending Reference doc and returns what the client needs to
 *  open the Paystack popup. Nothing is charged yet. */
export async function initSmsCreditPurchase({ organizerId, email, name, quantity, discountCode }) {
  // Everything money-related is recomputed here — the client's own idea of
  // the price is never trusted.
  const quote = await quoteSmsPurchase(quantity, discountCode);

  const timestamp = Date.now();
  const reference = buildSmsReference(timestamp);
  const now = new Date().toISOString();

  await REFERENCE_COLLECTION.doc(reference).set({
    reference,
    transactionType: SMS_TRANSACTION_TYPE,
    userId: organizerId,
    email,
    name,
    creditAmount: quote.quantity,
    unitPrice: quote.unitPrice,
    price: quote.subtotal,                 // credit price before any discount
    discountCode: quote.discountCode,
    discountPercent: quote.discountPercent,
    discountAmount: quote.discountAmount,
    discountedPrice: quote.discountedSubtotal,
    paystackFee: quote.vat,                // shown to buyers as "VAT"
    totalAmount: quote.total,
    status: "pending",
    creditsIssued: false,
    vendor: "paystack",
    createdAt: now,
    updatedAt: now,
  });

  return { reference, totalAmount: quote.total, email, name, quote };
}

/** Idempotent fulfilment — see file header. */
export async function verifyAndFulfillSmsPurchase(reference) {
  const refDoc = REFERENCE_COLLECTION.doc(reference);

  const snap = await refDoc.get();
  if (!snap.exists || snap.data()?.transactionType !== SMS_TRANSACTION_TYPE) {
    return { success: false, error: "reference_not_found" };
  }
  const refData = snap.data();
  if (refData.creditsIssued) return { success: true, alreadyIssued: true };

  const paystackData = await verifyWithPaystack(reference);
  const outcome = classifyPaystackStatus(paystackData);
  if (outcome === "failed") {
    await refDoc.update({ status: "failed", updatedAt: new Date().toISOString() });
    return { success: false, error: "payment_not_successful" };
  }
  if (outcome === "pending") return { success: false, error: "payment_pending" };

  // Compare in kobo, exactly: totals can carry kobo (₦456.75), so rounding to
  // whole naira like the email flow does would let a ₦0.50 underpayment pass.
  const paidKobo = Math.round(Number(paystackData.amount));
  const expectedKobo = Math.round(Number(refData.totalAmount) * 100);
  if (paidKobo !== expectedKobo) {
    await refDoc.update({ status: "failed", updatedAt: new Date().toISOString(), failureReason: "amount_mismatch" });
    return { success: false, error: "amount_mismatch" };
  }

  const shouldGrant = await adminDb.runTransaction(async (tx) => {
    const fresh = await tx.get(refDoc);
    if (fresh.data()?.creditsIssued) return false;
    tx.update(refDoc, {
      status: "successful",
      creditsIssued: true,
      paymentCompletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return true;
  });
  if (!shouldGrant) return { success: true, alreadyIssued: true };

  const credits = await grantSmsCredits(refData.userId, refData.creditAmount, reference);

  await sendCreditPurchaseConfirmationEmail({
    kind: "sms",
    to: refData.email,
    name: refData.name,
    reference,
    creditAmount: refData.creditAmount,
    rows: {
      unitPrice: refData.unitPrice,
      price: refData.price,
      discountAmount: refData.discountAmount,
      discountPercent: refData.discountPercent,
      fee: refData.paystackFee,
      total: refData.totalAmount,
    },
    paidAt: new Date().toISOString(),
  });

  return { success: true, credits };
}

/** Marks a still-pending SMS purchase failed — used by the webhook's
 *  charge.failed branch. A purchase that already succeeded is left alone. */
export async function markSmsPurchaseFailed(reference) {
  const refDoc = REFERENCE_COLLECTION.doc(reference);
  const snap = await refDoc.get();
  if (!snap.exists || snap.data()?.transactionType !== SMS_TRANSACTION_TYPE) return false;
  if (snap.data()?.creditsIssued) return false;
  await refDoc.update({ status: "failed", updatedAt: new Date().toISOString() });
  return true;
}
