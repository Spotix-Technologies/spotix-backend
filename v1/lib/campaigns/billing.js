/**
 * v1/lib/campaigns/billing.js
 *
 * Campaign credit purchases (spec §16–17). Reference doc shape and the
 * `SPTX-BKR-{timestamp}-{2 letters}` id mirror
 * spotix-user/src/app/api/v1/create-pay-ref/route.ts and
 * spotix-user/src/app/lib/reference-id.ts exactly, adapted for
 * `transactionType: "email_credit_purchase"`.
 *
 * Payment is verified server-side against Paystack's own API — never
 * trusted from the frontend's word (spec §17) — and fulfillment
 * (granting credits) is idempotent: both the client's immediate
 * /verify call and the webhook's later delivery can safely call
 * `verifyAndFulfillPurchase` for the same reference.
 */

import crypto from "node:crypto";
import { adminDb } from "../../firebase-admin.js";
import { getPackageById } from "./packages.js";
import { calculatePaystackFee } from "../mcp/pricing-math.js";
import { grantPurchasedCredits } from "./credits.js";
import { verifyWithPaystack, classifyPaystackStatus } from "./paystack-verify.js";
import { sendCreditPurchaseConfirmationEmail } from "./purchase-email.js";

const REFERENCE_COLLECTION = adminDb.collection("Reference");
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomLetters(length = 2) {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHA[crypto.randomInt(ALPHA.length)];
  return out;
}

function buildCreditReference(timestamp) {
  return `SPTX-BKR-${timestamp}-${randomLetters(2)}`;
}

export class PackageNotFoundError extends Error {}
export class PackageInactiveError extends Error {}

/** Creates the pending Reference doc and returns what the client needs
 *  to open the Paystack popup. Nothing is charged yet. */
export async function initCreditPurchase({ organizerId, email, name, packageId }) {
  const pkg = await getPackageById(packageId);
  if (!pkg) throw new PackageNotFoundError();
  if (!pkg.active) throw new PackageInactiveError();

  // Credits and analytics are no longer priced separately — one price
  // per package, and every purchase includes statistics (spec update:
  // "once admin sets price it allows analytics regardless").
  const price = Number(pkg.price);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(Number(pkg.credit_amount))) {
    // A malformed package doc (e.g. one with no `price` field) can't be sold.
    throw new PackageInactiveError();
  }
  const paystackFee = calculatePaystackFee(price);
  const totalAmount = price + paystackFee; // buyer bears the Paystack fee, spec §17

  const timestamp = Date.now();
  const reference = buildCreditReference(timestamp);

  await REFERENCE_COLLECTION.doc(reference).set({
    reference,
    transactionType: "email_credit_purchase",
    userId: organizerId,
    email,
    name,
    packageId,
    creditAmount: pkg.credit_amount,
    price,
    paystackFee,
    totalAmount,
    statisticsEnabled: true,
    status: "pending",
    creditsIssued: false,
    vendor: "paystack",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return { reference, totalAmount, email, name };
}

/** Idempotent — safe to call from both the client's /verify request and
 *  the webhook. Only the first successful call actually grants credits
 *  (guarded by a Firestore transaction on `creditsIssued`). */
export async function verifyAndFulfillPurchase(reference) {
  const refDoc = REFERENCE_COLLECTION.doc(reference);

  const snap = await refDoc.get();
  if (!snap.exists || snap.data()?.transactionType !== "email_credit_purchase") {
    return { success: false, error: "reference_not_found" };
  }
  const refData = snap.data();
  if (refData.creditsIssued) {
    return { success: true, alreadyIssued: true };
  }

  const paystackData = await verifyWithPaystack(reference);
  const outcome = classifyPaystackStatus(paystackData);
  if (outcome === "failed") {
    await refDoc.update({ status: "failed", updatedAt: new Date().toISOString() });
    return { success: false, error: "payment_not_successful" };
  }
  if (outcome === "pending") {
    // Not paid (yet) — leave the reference pending so a later verify or the
    // webhook can still fulfil it if the buyer finishes paying elsewhere.
    return { success: false, error: "payment_pending" };
  }
  // Amount is in kobo — never trust the client's word for what was paid.
  const paidNaira = paystackData.amount / 100;
  if (Math.round(paidNaira) !== Math.round(refData.totalAmount)) {
    await refDoc.update({ status: "failed", updatedAt: new Date().toISOString(), failureReason: "amount_mismatch" });
    return { success: false, error: "amount_mismatch" };
  }

  // Firestore transaction closes the race between a client /verify call
  // and the webhook both observing creditsIssued:false at the same time.
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

  // Credits go to the booker's account, not an event. (Purchases made before
  // the account-level change carry an eventId on the Reference doc; it is
  // ignored — those credits land in the same account balance.)
  const credits = await grantPurchasedCredits(
    refData.userId, refData.creditAmount, reference, refData.statisticsEnabled
  );

  // Confirmation email (SES). Never throws — a mail hiccup must not undo or
  // fail a purchase that's already been paid for and credited.
  await sendCreditPurchaseConfirmationEmail({
    kind: "email",
    to: refData.email,
    name: refData.name,
    reference,
    creditAmount: refData.creditAmount,
    rows: {
      price: refData.price,
      fee: refData.paystackFee,
      total: refData.totalAmount,
    },
    paidAt: new Date().toISOString(),
  });

  return { success: true, credits };
}
