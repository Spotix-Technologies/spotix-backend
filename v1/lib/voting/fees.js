// v1/lib/voting/fees.js
//
// Royalty / service-fee math for a vote purchase. Mirrors
// booker/app/lib/poll-config.ts — keep both in sync.
//
//   ROYALTY_PERCENT = 5
//   buyerBearsBurden (immutable, set on voting/{pollId} at poll creation):
//     true  → buyer absorbs the fee; poll receives the vote's base amount
//              (serviceFee = calcServiceFee(baseAmount), same formula as poll-config.ts)
//     false → creator absorbs the fee; poll receives 95% of totalAmount
//              (serviceFee = 5% of totalAmount, same as calcSellerNet in poll-config.ts)
//   The NET amount (totalAmount − serviceFee) is what gets credited to
//   voting/{pollId}.pollAmount, the daily admin/votes doc, and the creator's
//   user/{creatorId} stats — i.e. it's the only amount that is ever payable out.

export const ROYALTY_PERCENT = 5;

/** Service fee charged on top of baseAmount when the buyer bears the burden. */
export function calcServiceFee(baseAmount) {
  const buyerTotal = Math.round(baseAmount * (1 + ROYALTY_PERCENT / 100));
  return buyerTotal - baseAmount;
}

/** Net amount the creator/poll receives when the creator bears the burden. */
export function calcSellerNet(grossAmount) {
  return Math.round(grossAmount * (1 - ROYALTY_PERCENT / 100));
}

/**
 * Compute the service fee and net (payable) amount for a vote transaction.
 *
 * @param buyerBearsBurden - from voting/{pollId}.buyerBearsBurden (authoritative)
 * @param totalAmount      - gross amount actually paid by the voter
 * @param baseAmount       - pollPrice × voteCount (the organiser's clean price)
 */
export function computeVoteFee(buyerBearsBurden, totalAmount, baseAmount) {
  if (buyerBearsBurden) {
    // Buyer already absorbed the fee — poll should net out to ~baseAmount.
    const fee = Math.min(calcServiceFee(baseAmount), totalAmount);
    return { serviceFee: fee, netAmount: totalAmount - fee };
  }
  // Creator bears the burden — 5% comes off the top before it's payable.
  const netAmount = calcSellerNet(totalAmount);
  return { serviceFee: totalAmount - netAmount, netAmount };
}
