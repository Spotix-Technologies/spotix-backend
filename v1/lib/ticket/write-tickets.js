// v1/lib/ticket/write-tickets.js
//
// Steps 4 & 5 of ticket generation: persist tickets/{ticketId} and the
// mirrored events/{eventId}/attendees/{ticketId} doc for every seat.

/**
 * @returns {Promise<string[]>} createdTicketIds, in seat order
 */
export async function writeTicketsAndAttendees(
  fastify,
  adminDb,
  { paymentData, ticketSeats, ticketIds, reference, buyerFullName, buyerEmail, buyerPhone, isGuest, nowIso }
) {
  const baseTicketFields = {
    uid: paymentData.userId || paymentData.guestEmail || paymentData.userEmail,
    isGuest,
    fullName: buyerFullName,
    email: buyerEmail,
    phoneNumber: buyerPhone,
    ticketReference: reference,
    purchaseDate: new Date(nowIso).toLocaleDateString(),
    purchaseTime: new Date(nowIso).toLocaleTimeString(),
    verified: false,
    paymentMethod: "Paystack",
    discountApplied: !!paymentData.discountCode,
    discountCode: paymentData.discountCode || null,
    referralCode: paymentData.referralCode || null,
    referralName: paymentData.referralName || null,
    eventId: paymentData.eventId,
    eventName: paymentData.eventName,
    eventCreatorId: paymentData.eventCreatorId,
    eventVenue: paymentData.eventVenue || null,
    eventType: paymentData.eventType || null,
    eventDate: paymentData.eventDate || null,
    eventEndDate: paymentData.eventEndDate || null,
    eventStart: paymentData.eventStart || null,
    eventEnd: paymentData.eventEnd || null,
    totalAmount: paymentData.totalAmount || 0,
    transactionFee: paymentData.transactionFee || 0,
    createdAt: nowIso,
  };

  const createdTicketIds = [];

  for (let i = 0; i < ticketSeats.length; i++) {
    const seat = ticketSeats[i];
    const ticketId = ticketIds[i];

    const ticketDoc = {
      ...baseTicketFields,
      ticketId,
      ticketType: seat.type,
      ticketPrice: seat.price,
      originalPrice: seat.price,
    };

    const ticketRef = adminDb.collection("tickets").doc(ticketId);
    const ticketSnap = await ticketRef.get();
    if (!ticketSnap.exists) {
      await ticketRef.set(ticketDoc);
    } else {
      fastify.log.info(`[step:4] tickets/${ticketId} already exists — skipping`);
    }

    const attendeeRef = adminDb
      .collection("events")
      .doc(paymentData.eventId)
      .collection("attendees")
      .doc(ticketId);
    const attendeeSnap = await attendeeRef.get();
    if (!attendeeSnap.exists) {
      await attendeeRef.set(ticketDoc);
    } else {
      fastify.log.info(`[step:5] attendees/${ticketId} already exists — skipping`);
    }

    createdTicketIds.push(ticketId);
  }

  fastify.log.info(`[step:4-5] Tickets and attendees written: ${createdTicketIds.join(", ")}`);

  return createdTicketIds;
}
