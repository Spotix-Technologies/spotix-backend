// v1/lib/merch/order-id.js
//
// Generates the buyer-facing order id for a single merch order line —
// SPTX-MH-{10 random alphanumeric}. One id per line item in the cart
// (one Supabase merch_orders row + one Firestore Merch/{orderId} doc
// each) — see index.js.

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomAlphanumeric(length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHANUMERIC[Math.floor(Math.random() * ALPHANUMERIC.length)];
  }
  return out;
}

/** Builds a merch order id: SPTX-MH-{10 random alphanumeric} */
export function generateMerchOrderId() {
  return `SPTX-MH-${randomAlphanumeric(10)}`;
}
