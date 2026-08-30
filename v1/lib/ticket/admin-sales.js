// v1/lib/ticket/admin-sales.js
//
// Step 8 of ticket generation: roll this sale into the booker's daily
// aggregate at admin/events/{eventId}/{YYYY-MM-DD}. For agent-facilitated
// sales, what lands here is the amount AFTER the agent's incentive is
// removed — the incentive was the agent's cut, not the booker's, so it
// never counted toward the booker's withdrawable balance in the first
// place (see agent-sale.js for the agent-side ledger entry the incentive
// amount actually goes to).
//
// Burden of Fee: paymentData.feeBurden (Spotix's fee and Paystack's fee
// are independent switches) is frozen on the Reference at purchase time
// (see create-pay-ref in spotix-user) from whatever the event's setting
// was at that moment — so a booker flipping the toggle later never
// rewrites what a past sale already settled as. Whichever of the two the
// booker chose to cover comes out of what lands here, using the exact
// amounts frozen alongside it (paymentData.transactionFee for Spotix's
// fee, paymentData.organizerPaystackFeeCost for Paystack's) — never
// recomputed from today's rates. paymentData.feeBurden falls back to
// deriving from the legacy paymentData.buyerBearsBurden for references
// old enough to only have that field.
//
// paystackFeeAbsorbedBy ("organizer" | "spotix", set from spotix-admin
// only) further decides WHERE organizerPaystackFeeCost actually comes
// out of when the buyer doesn't pay Paystack's fee: "organizer" (default,
// same behaviour as before this field existed) deducts it right here from
// bookerNetAmount; "spotix" leaves bookerNetAmount untouched entirely —
// the organizer is paid out in full as if the buyer had covered it, and
// the shortfall between what Paystack actually remitted and what's paid
// out here is absorbed by Spotix's own platform-fee margin instead. There
// is no separate "Spotix ledger" write for this: not deducting it from
// the organizer IS Spotix absorbing it, since nothing else changes.
//
// Addons: paymentData.organizerAddonCostTotal is the sum of every
// organizer-covered addon (see spotix-admin's Addons tab) on this
// purchase — attendee-covered addons never touch this, they were
// already collected from the buyer and aren't the booker's to begin
// with. Also frozen on the Reference at purchase time, so a later addon
// edit/deactivation can't rewrite a past sale either. Non-blocking.

import { FieldValue } from "firebase-admin/firestore";

export async function updateAdminDailySales(
  fastify,
  adminDb,
  { paymentData, totalTicketCount, agentIncentiveAmount, nowIso, purchaseTime }
) {
  const purchaseDateFormatted = nowIso.split("T")[0];
  const adminSalesRef = adminDb
    .collection("admin")
    .doc("events")
    .collection(paymentData.eventId)
    .doc(purchaseDateFormatted);

  // feeBurden is the canonical field going forward; buyerBearsBurden is
  // the pre-Paystack-fee-split legacy field, kept in sync by create-pay-ref
  // for exactly this fallback. Either way: unset/missing → attendee pays
  // both, matching how every sale worked before Burden of Fee existed.
  const feeBurden = paymentData.feeBurden ?? {
    coversPaystackFee: false,
    coversSpotixFee: paymentData.buyerBearsBurden === false,
    paystackFeeAbsorbedBy: "organizer",
  };
  const spotixFeeBurden = feeBurden.coversSpotixFee ? (paymentData.transactionFee || 0) : 0;
  // organizerPaystackFeeCost is already 0 when the buyer covered Paystack's
  // fee (see computeOrderPricing in spotix-user) — no extra gating needed
  // for that half. What's gated here is WHO it comes out of: only deduct
  // from the booker's balance when Spotix hasn't been set to absorb it.
  const paystackFeeAbsorbedBySpotix = feeBurden.coversPaystackFee && feeBurden.paystackFeeAbsorbedBy === "spotix";
  const paystackFeeBurden = paystackFeeAbsorbedBySpotix ? 0 : (paymentData.organizerPaystackFeeCost || 0);
  const organizerAddonCost = paymentData.organizerAddonCostTotal || 0;

  const bookerNetAmount = Math.max(
    0,
    (paymentData.ticketPrice || 0) -
      agentIncentiveAmount -
      spotixFeeBurden -
      paystackFeeBurden -
      organizerAddonCost
  );

  try {
    const salesDoc = await adminSalesRef.get();
    // We hold the processingLock so no other request can reach this step
    // for this reference. No need to re-check ticketGenerated here.
    if (!salesDoc.exists) {
      await adminSalesRef.set({
        eventName: paymentData.eventName,
        ticketCount: totalTicketCount,
        ticketSales: bookerNetAmount,
        lastPurchaseTime: purchaseTime,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } else {
      await adminSalesRef.update({
        ticketCount: FieldValue.increment(totalTicketCount),
        ticketSales: FieldValue.increment(bookerNetAmount),
        lastPurchaseTime: purchaseTime,
        updatedAt: nowIso,
      });
    }

    fastify.log.info(`[step:8] Daily sales updated for ${purchaseDateFormatted}`);
  } catch (error) {
    fastify.log.error("[step:8] Daily sales aggregation error (non-blocking):", error);
  }
}

