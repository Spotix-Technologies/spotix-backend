// v1/lib/mcp/pricing-math.js
//
// Plain-JS port of spotix-user/src/utils/priceUtility.ts, kept for the
// MCP endpoints (v1/mcp/*) so the SAME platform-fee / Paystack-fee /
// Burden-of-Fee / addon math that create-pay-ref uses is what an AI
// chat model sees via get_pricing and what create_ticket_order actually
// charges — this backend is the one authoritative source both spotix-user
// and the MCP now read from for anything money-related.
//
// Keep this in sync with priceUtility.ts if that file's formulas ever
// change — there is deliberately no cross-repo import here (spotix-user
// is a separate deployable), so this is a conscious duplication, not a
// missed shared-package opportunity.

export const DEFAULT_PLATFORM_PERCENTAGE_FEE = 5; // whole percent
const DEFAULT_PLATFORM_FLAT_FEE = 0; // NOT the ₦100 admin-UI suggestion — see below

/**
 * Resolves the fee rates actually in effect for an event.
 * Missing/null percentage -> system default (5%).
 * Missing/null flat fee -> 0, never a silently-assumed ₦100.
 */
export function resolvePlatformFeeRates(event) {
  const rawPercentage = event?.platformPercentageFee;
  const percentagePercent =
    typeof rawPercentage === "number" && Number.isFinite(rawPercentage)
      ? rawPercentage
      : DEFAULT_PLATFORM_PERCENTAGE_FEE;

  const rawFlat = event?.platformFlatFee;
  const flatFee = typeof rawFlat === "number" && Number.isFinite(rawFlat) ? rawFlat : DEFAULT_PLATFORM_FLAT_FEE;

  return { percentageFee: percentagePercent / 100, flatFee };
}

/** Spotix's platform fee for a single ticket price. Free tickets: 0. */
export function calculateVATFee(ticketPrice, rates) {
  if (!ticketPrice) return 0;
  return ticketPrice * rates.percentageFee + rates.flatFee;
}

/**
 * Real Paystack fee for a local NGN charge: 1.5% + ₦100 (waived under
 * ₦2,500), capped at ₦2,000 total. Matches calculatePaystackFee in
 * priceUtility.ts.
 */
export function calculatePaystackFee(amount) {
  if (!amount || amount <= 0) return 0;
  const raw = amount * 0.015 + (amount >= 2500 ? 100 : 0);
  return Math.min(2000, raw);
}

/**
 * Resolves who pays what for an event. Mirrors resolveFeeBurden() in
 * priceUtility.ts, including the legacy buyerBearsBurden migration.
 */
export function resolveFeeBurden(event) {
  if (event?.feeBurden && typeof event.feeBurden === "object") {
    return {
      coversPaystackFee: event.feeBurden.coversPaystackFee === true,
      coversSpotixFee: event.feeBurden.coversSpotixFee === true,
      paystackFeeAbsorbedBy: event.feeBurden.paystackFeeAbsorbedBy === "spotix" ? "spotix" : "organizer",
    };
  }
  return {
    coversPaystackFee: false,
    coversSpotixFee: event?.buyerBearsBurden === false,
    paystackFeeAbsorbedBy: "organizer",
  };
}

/**
 * The single source of truth for what a buyer pays and what an
 * organizer's payout is reduced by. Mirrors computeOrderPricing() in
 * priceUtility.ts exactly (additive Paystack fee, not a gross-up).
 *
 * input: { ticketSubtotal, totalTicketCount, spotixFeeTotal, feeBurden, addons }
 */
export function computeOrderPricing(input) {
  const { ticketSubtotal, totalTicketCount, spotixFeeTotal, feeBurden, addons = [] } = input;

  const attendeeAddonPerTicket = addons
    .filter((a) => a.coveredBy === "attendee")
    .reduce((sum, a) => sum + (Number(a.pricePerTicket) || 0), 0);
  const organizerAddonPerTicket = addons
    .filter((a) => a.coveredBy === "organizer")
    .reduce((sum, a) => sum + (Number(a.pricePerTicket) || 0), 0);

  const addonFeeTotal = attendeeAddonPerTicket * totalTicketCount;
  const organizerAddonCostTotal = organizerAddonPerTicket * totalTicketCount;

  const buyerOwesSpotixFee = !feeBurden.coversSpotixFee;
  const buyerOwesPaystackFee = !feeBurden.coversPaystackFee;

  const preFeeAmount = ticketSubtotal + (buyerOwesSpotixFee ? spotixFeeTotal : 0) + addonFeeTotal;
  const paystackFeeTotal = calculatePaystackFee(preFeeAmount);
  const paystackFeeChargedToBuyer = buyerOwesPaystackFee ? paystackFeeTotal : 0;
  const organizerPaystackFeeCost = buyerOwesPaystackFee ? 0 : paystackFeeTotal;

  return {
    ticketSubtotal,
    spotixFeeTotal,
    addonFeeTotal,
    organizerAddonCostTotal,
    paystackFeeTotal,
    paystackFeeChargedToBuyer,
    organizerPaystackFeeCost,
    buyerOwesSpotixFee,
    buyerOwesPaystackFee,
    totalPayable: preFeeAmount + paystackFeeChargedToBuyer,
  };
}
