// v1/lib/merch/index.js
//
// Orchestrates the full merch-order-crediting pipeline out of the step
// modules in this folder. This is the only file merch.js needs to import
// from — mirrors v1/lib/voting/index.js's shape:
//
//   reference.js             — load Reference/{reference}, idempotency guard,
//                               stamp payment outcome (steps 1-3)
//   order-id.js               — SPTX-MH-{10 alphanumeric} order id generator
//   supabase-order.js          — record_merch_order() RPC — one call per cart
//                                line, atomically inserts the order row AND
//                                decrements merch_listings.quantity (step 4a)
//   write-merch-order.js        — Merch/{orderId} + events/{eventId}/merchOrders
//                                mirror doc, one per cart line (step 4b)
//   admin-merch-sales.js         — admin/merch/{listingId}/{date}, one per
//                                cart line, payout-eligible net amount (step 4c)
//   analytics.js                  — admin/analytics daily/monthly/yearly,
//                                once per whole checkout (step 5)
//   merch-confirmation-email.js    — buyer receipt, once per whole checkout (step 6)
//
// Firestore layout (FLAT):
//   Reference/{reference}          <- payment reference (SPTX-REF-{timestamp}-{AA})
//                                      (same collection ticket.js/voting.js use)
//   Merch/{orderId}                <- global order record, one per cart line
//   events/{eventId}/merchOrders/{orderId} <- per-event mirror
//   admin/merch/{listingId}/{date} <- daily aggregation, mirrors
//                                      admin/events/{eventId}/{date} (tickets)
//
// Cart shape: a single checkout can contain several distinct listings
// (refData.merchItems, each { listingId, productName, quantity, price,
// lineTotal, feeBurden, organizerNetAmount, ... }). Each line becomes its
// own order id, its own Supabase merch_orders row, and its own
// Merch/{orderId} doc — mirroring how one ticket purchase can expand into
// several individual ticket docs. Only analytics + the confirmation email
// happen once per whole checkout, not once per line.
//
// Fee burden is PER LISTING, not per order (unlike tickets, where Burden
// of Fee is one event-wide setting) — create-merch-ref already resolved
// each line's own booker-chosen burden into `line.organizerNetAmount`
// (gross minus whatever fee(s) that specific booker chose to absorb), so
// this file just reads it straight off each line rather than re-deriving
// any fee-burden math itself.

import { adminDb } from "../../utils/firebase.js";

import {
  loadReference,
  isAlreadyProcessed,
  markReferenceStatus,
  claimMerchCreditLock,
  finalizeMerchCredit,
  releaseMerchCreditLock,
} from "./reference.js";
import { generateMerchOrderId } from "./order-id.js";
import { recordMerchOrder } from "./supabase-order.js";
import { writeMerchOrder } from "./write-merch-order.js";
import { updateDailyMerchSales } from "./admin-merch-sales.js";
import { reportMerchAnalytics } from "./analytics.js";
import { sendMerchConfirmationEmail } from "./merch-confirmation-email.js";

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {"charge.success"|"charge.failed"} event
 * @param {object} data   — Paystack event data
 * @param {string} reference — SPTX-REF-{timestamp}-{AA}
 */
export async function processMerchCharge(fastify, event, data, reference) {
  const paymentStatus = event === "charge.success" ? "successful" : "failed";

  //  Steps 1-2: load reference + idempotency guard ─
  const loaded = await loadReference(fastify, adminDb, reference);
  if (!loaded) return { status: "not_found", reference };
  const { referenceRef, refData } = loaded;

  if (isAlreadyProcessed(refData)) {
    fastify.log.info(`[merch] ${reference} already credited — skipped`);
    return { status: "already_processed", reference };
  }

  //  Step 3: stamp payment outcome onto the reference ─
  await markReferenceStatus(fastify, referenceRef, reference, event, data, paymentStatus);

  if (paymentStatus === "failed") {
    return { status: "failed", reference };
  }

  //  Atomic claim: only ONE concurrent caller may credit this order 
  const claim = await claimMerchCreditLock(adminDb, referenceRef);

  if (claim.claimResult === "already_credited") {
    fastify.log.info(`[merch] ${reference} already credited — skipped`);
    return { status: "already_processed", reference };
  }
  if (claim.claimResult === "locked") {
    fastify.log.warn(`[merch] ${reference} credit already in progress elsewhere — skipping duplicate`);
    return { status: "processing", reference };
  }

  // claim.claimResult === "claimed" — we hold the lock now, and MUST always
  // resolve it below (finalize on success, release-without-credit on error)
  // so a genuine failure doesn't permanently block a future retry.
  const liveRefData = claim.refData ?? refData;
  const {
    merchItems,
    totalUnitsCount,
    totalAmount,
    transactionFee,
    userId,
    userFullName,
    userEmail,
    userPhone,
    buyerAddress,
  } = liveRefData;

  if (!Array.isArray(merchItems) || merchItems.length === 0) {
    fastify.log.warn(`[merch] Missing merchItems on reference ${reference} — nothing to credit`);
    await finalizeMerchCredit(fastify, referenceRef, reference, []);
    return { status: "successful_no_items", reference };
  }

  const orderIds = [];
  let creditSucceeded = false;

  try {
    for (const line of merchItems) {
      const orderId = generateMerchOrderId();
      orderIds.push(orderId);

      //  Step 4a: Supabase — insert order row + decrement stock (atomic) 
      await recordMerchOrder({
        orderId,
        listingId: line.listingId,
        fullName: userFullName ?? "",
        username: null,
        email: userEmail ?? "",
        phoneNumber: userPhone ?? "",
        address: buyerAddress ?? "",
        qty: line.quantity,
        amountPaid: line.lineTotal, // gross, pre-fee — same convention as ticket's ticketPrice
        buyerUserId: userId ?? null,
      });

      //  Step 4b: Firestore — Merch/{orderId} + event mirror 
      await writeMerchOrder(adminDb, { orderId, reference, line, refData: liveRefData });

      //  Step 4c: admin/merch/{listingId}/{date} daily aggregation 
      // organizerNetAmount was already computed per-line by create-merch-ref
      // (gross minus whatever fee(s) THIS listing's booker chose to absorb)
      // — no re-deriving fee-burden math here.
      const netLineAmount =
        typeof line.organizerNetAmount === "number" ? line.organizerNetAmount : line.lineTotal;
      await updateDailyMerchSales(fastify, adminDb, {
        listingId: line.listingId,
        productName: line.productName,
        quantity: line.quantity,
        netLineAmount,
        reference,
      });
    }

    // Everything above committed without throwing — safe to lock the
    // credit in now so no later redelivery/reconciliation can double it.
    await finalizeMerchCredit(fastify, referenceRef, reference, orderIds);
    creditSucceeded = true;
  } catch (err) {
    // Payment is recorded, but crediting didn't fully complete — release
    // the lock (without marking credited) so this reference can be
    // safely retried by the next webhook redelivery or reconciliation.
    // Note: any orderIds already written above are NOT rolled back — a
    // retry from here re-runs the whole loop, which would double-write
    // those lines. Acceptable for now (mirrors how ticket.js/voting.js
    // handle partial failure), flagged here for future hardening.
    fastify.log.error(`[merch] Order crediting failed for ${reference} (will retry on next attempt):`, err);
    await releaseMerchCreditLock(fastify, referenceRef, reference);
  }

  //  Step 6: buyer confirmation email 
  // Only ever sent once the order is actually credited — never on the
  // error path above, so a buyer never gets a receipt for an order that
  // didn't land.
  if (creditSucceeded) {
    await sendMerchConfirmationEmail(fastify, { refData: liveRefData, reference, orderIds });
  }

  //  Step 5: admin analytics 
  // transactionFee is already "the Spotix fee actually charged to the
  // buyer, summed across lines" (0 if every line's booker absorbed it) —
  // no burden boolean needed here, unlike tickets/voting.
  await reportMerchAnalytics(fastify, adminDb, {
    totalUnitsCount,
    totalAmount,
    transactionFee,
    reference,
  });

  return { status: "successful", reference, orderIds };
}
