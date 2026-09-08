// v1/lib/mcp/pricing.js
//
// get_pricing logic — GET /mcp/events/:eventId/pricing. Loads the event
// straight from Firestore (fresher than the search snapshot — quantity
// remaining changes on every sale) and applies the exact same fee/
// addon/sale-window math create-pay-ref uses, so a price quoted to an
// AI chat model is never out of step with what create_ticket_order will
// actually charge a moment later.

import { adminDb } from "../../firebase-admin.js";
import { resolvePlatformFeeRates, resolveFeeBurden, calculateVATFee, computeOrderPricing } from "./pricing-math.js";
import { getTicketSaleStatus, describeSaleStatus } from "./sale-window.js";

export class PricingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function getEventPricing(eventId) {
  const eventRef = adminDb.collection("events").doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw new PricingError("Event not found", 404);

  const event = eventSnap.data();
  if (event.suspended) throw new PricingError("This event is currently unavailable", 403);

  const feeRates = resolvePlatformFeeRates(event);
  const feeBurden = resolveFeeBurden(event);
  const eventWideStop = { enabled: !!event.stopDate, stopDate: event.stopDate ?? null };

  const addonsSnap = await eventRef.collection("addons").get();
  const activeAddons = addonsSnap.docs
    .map((d) => d.data())
    .filter((a) => a.active !== false)
    .map((a) => ({
      name: a.name ?? "",
      pricePerTicket: typeof a.pricePerTicket === "number" ? a.pricePerTicket : 0,
      coveredBy: a.coveredBy === "organizer" ? "organizer" : "attendee",
    }));

  const ticketPrices = Array.isArray(event.ticketPrices) ? event.ticketPrices : [];

  const policies = ticketPrices.map((ticket) => {
    const price = Number(ticket.price) || 0;
    const saleStatus = getTicketSaleStatus(ticket, eventWideStop);

    // Single-ticket breakdown at THIS policy's price, so an AI model can
    // quote "a Regular ticket costs ₦X all-in" without needing to know
    // quantity yet. create_ticket_order recomputes for the real cart.
    const spotixFeeForOne = calculateVATFee(price, feeRates);
    const single = computeOrderPricing({
      ticketSubtotal: price,
      totalTicketCount: 1,
      spotixFeeTotal: spotixFeeForOne,
      feeBurden,
      addons: activeAddons,
    });

    const hasLimit =
      ticket.availableTickets !== null && ticket.availableTickets !== undefined && ticket.availableTickets !== "";

    return {
      policy: ticket.policy,
      basePrice: price,
      currency: "NGN",
      totalPricePerTicket: single.totalPayable,
      feeBreakdown: {
        spotixFee: single.buyerOwesSpotixFee ? single.spotixFeeTotal : 0,
        paystackFee: single.paystackFeeChargedToBuyer,
        addonFee: single.addonFeeTotal,
      },
      availability: hasLimit
        ? { limited: true, remaining: Math.max(0, Number(ticket.availableTickets) || 0) }
        : { limited: false, remaining: null },
      onSale: saleStatus.onSale,
      saleStatusMessage: describeSaleStatus(saleStatus),
    };
  });

  return {
    eventId,
    eventName: event.eventName,
    isFree: !!event.isFree,
    currency: "NGN",
    platformFeeRate: `${feeRates.percentageFee * 100}%${feeRates.flatFee ? ` + ₦${feeRates.flatFee}` : ""}`,
    feeBurden: {
      whoPaysSpotixFee: feeBurden.coversSpotixFee ? "organizer" : "attendee",
      whoPaysPaystackFee: feeBurden.coversPaystackFee ? feeBurden.paystackFeeAbsorbedBy : "attendee",
    },
    virtualQueueEnabled: !!event.virtualQueueEnabled,
    policies,
  };
}
