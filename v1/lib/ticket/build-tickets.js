// v1/lib/ticket/build-tickets.js
//
// Steps 2 & 3 of ticket generation: expand the reference's ticketTypes
// (cart line items with quantity) into one seat per physical ticket, then
// mint (or reuse, on retry) a ticketId for every seat.

/**
 * Step 2 — expand cart line items into one entry per physical seat.
 */
export function buildTicketSeats(fastify, paymentData, reference) {
  const ticketTypesArray =
    paymentData.ticketTypes &&
    Array.isArray(paymentData.ticketTypes) &&
    paymentData.ticketTypes.length > 0
      ? paymentData.ticketTypes
      : [{ type: paymentData.ticketType, quantity: 1, price: paymentData.ticketPrice }];

  const ticketSeats = [];
  for (const item of ticketTypesArray) {
    const qty = Number(item.quantity) || 1;
    for (let i = 0; i < qty; i++) {
      ticketSeats.push({ type: item.type, price: Number(item.price) || 0 });
    }
  }

  const totalTicketCount = ticketSeats.length;
  fastify.log.info(`[step:2] ${totalTicketCount} ticket(s) to generate for ${reference}`);

  return { ticketTypesArray, ticketSeats, totalTicketCount };
}

/**
 * Step 3 — generate a fresh ticketId per seat, or reuse the ones already
 * written to the reference doc if this is a retried call for the same
 * totalTicketCount (keeps IDs stable across webhook + fallback races).
 */
export async function assignTicketIds(fastify, adminDb, referenceDocRef, ticketSeats, totalTicketCount) {
  let ticketIds = [];

  await adminDb.runTransaction(async (transaction) => {
    const refDoc = await transaction.get(referenceDocRef);
    if (!refDoc.exists) throw new Error("Reference document not found during transaction");

    const refData = refDoc.data();

    if (
      refData.ticketIds &&
      Array.isArray(refData.ticketIds) &&
      refData.ticketIds.length === totalTicketCount
    ) {
      ticketIds = refData.ticketIds;
      fastify.log.info(`[step:3] Reusing existing ticketIds: ${ticketIds.join(", ")}`);
    } else {
      ticketIds = ticketSeats.map(() => generateTicketId());
      fastify.log.info(`[step:3] Generated ticketIds: ${ticketIds.join(", ")}`);
      transaction.update(referenceDocRef, {
        ticketIds,
        ticketIdGeneratedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  });

  return ticketIds;
}

export function generateTicketId() {
  const randomNumbers = Math.floor(10000000 + Math.random() * 90000000).toString();
  const randomLetters = Math.random().toString(36).substring(2, 4).toUpperCase();

  const pos1 = Math.floor(Math.random() * 8);
  const pos2 = Math.floor(Math.random() * 7) + pos1 + 1;

  const part1 = randomNumbers.substring(0, pos1);
  const part2 = randomNumbers.substring(pos1, pos2);
  const part3 = randomNumbers.substring(pos2);

  return `SPTX-TX-${part1}${randomLetters[0]}${part2}${randomLetters[1]}${part3}`;
}
