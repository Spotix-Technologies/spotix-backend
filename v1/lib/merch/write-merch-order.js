// v1/lib/merch/write-merch-order.js
//
// Writes the Firestore side of one merch order LINE (one listing, one
// quantity) — mirrors what lib/ticket/write-tickets.js does for tickets:
//   tickets/{ticketId}                        <- global doc
//   events/{eventId}/attendees/{ticketId}      <- per-event mirror
// becomes, for merch:
//   Merch/{orderId}                            <- global doc
//   events/{eventId}/merchOrders/{orderId}     <- per-event mirror
//
// This is Firestore-side bookkeeping only — the authoritative order
// record (and the only thing that actually decrements stock) is the
// merch_orders row in Supabase, written by supabase-order.js. This
// collection exists so booker-side and admin-side tooling that already
// expects "everything important has a Firestore trail" (like tickets)
// has one for merch too.

/**
 * @param {import('firebase-admin').firestore.Firestore} adminDb
 * @param {object} params
 * @param {string} params.orderId
 * @param {string} params.reference
 * @param {object} params.line          one entry from refData.merchItems
 * @param {object} params.refData       the full Reference doc data
 */
export async function writeMerchOrder(adminDb, { orderId, reference, line, refData }) {
  const now = new Date().toISOString();

  const orderDoc = {
    orderId,
    reference,
    listingId: line.listingId,
    productName: line.productName,
    quantity: line.quantity,
    price: line.price, // unit price
    lineTotal: line.lineTotal,
    // Fee-burden breakdown for this specific listing (set by its booker,
    // independent of any other line in the same order — see
    // create-merch-ref/route.ts) — kept here for audit/display, not
    // re-derived from anything.
    feeBurden: line.feeBurden ?? null,
    spotixFeeAmount: line.spotixFeeAmount ?? 0,
    paystackFeeShare: line.paystackFeeShare ?? 0,
    organizerNetAmount: typeof line.organizerNetAmount === "number" ? line.organizerNetAmount : line.lineTotal,
    bookerId: refData.eventCreatorId,
    eventId: refData.eventId,
    eventCreatorId: refData.eventCreatorId,
    eventName: refData.eventName ?? "",
    buyerUserId: refData.userId ?? null,
    buyerFullName: refData.userFullName ?? "",
    buyerEmail: refData.userEmail ?? "",
    buyerPhone: refData.userPhone ?? "",
    buyerAddress: refData.buyerAddress ?? "",
    status: "Processing", // mirrors merch_orders.status default — Processing | Shipped | Delivered
    orderDate: now,
    createdAt: now,
    updatedAt: now,
  };

  const batch = adminDb.batch();

  const globalRef = adminDb.collection("Merch").doc(orderId);
  batch.set(globalRef, orderDoc);

  const eventMirrorRef = adminDb
    .collection("events")
    .doc(refData.eventId)
    .collection("merchOrders")
    .doc(orderId);
  batch.set(eventMirrorRef, orderDoc);

  await batch.commit();
}
