// v1/lib/mcp/orders.js
//
// create_ticket_order + verify_payment's order-lookup logic.
//
// createOrder() is the MCP-channel equivalent of spotix-user's
// app/api/v1/create-pay-ref/route.ts: same server-side-recomputed
// pricing (nothing from the caller is trusted for money), same
// Reference doc shape (so the existing webhook/verify-payment/
// ticket-generation pipeline needs zero changes to handle an
// MCP-originated purchase) — with an added virtual-queue gate up front,
// since an AI chat model has no browser session to hold a queue slot in.
//
// getOrder() backs verify_payment's post-reconciliation lookup: once
// v1/verify-payment.js has confirmed payment and generateTickets() has
// run, this just reads back the public-safe fields + builds this
// backend's own self-hosted QR code URLs (v1/qrcode.js).
//
// createOrder() does NOT mint a Paystack authorization_url itself — an
// AI chat client can't render Paystack's own hosted checkout page in any
// useful way. Instead it hands back a link to spotix-user's own
// /payment/mcp/{reference} page, which greets the buyer, shows the same
// order summary, lets them pick a payment channel, and opens the
// Paystack INLINE popup client-side (same widget every other Spotix
// checkout surface uses) against this exact reference. No second
// pricing/inventory decision is made there — that page is read-only
// against the Reference doc this function writes.

import { adminDb } from "../../firebase-admin.js";
import { resolvePlatformFeeRates, resolveFeeBurden, calculateVATFee, computeOrderPricing } from "./pricing-math.js";
import { getTicketSaleStatus, describeSaleStatus } from "./sale-window.js";
import { buildTicketReference } from "./reference.js";

const MAX_QTY_PER_TYPE = 10;

export class OrderError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

/**
 * input: { eventId, ticketType, quantity, customerEmail, customerName, customerPhone }
 */
export async function createOrder(fastify, input) {
  const { eventId, ticketType, quantity, customerEmail, customerName, customerPhone } = input;

  if (!eventId) throw new OrderError("eventId is required");
  if (!ticketType) throw new OrderError("ticketType is required");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_TYPE) {
    throw new OrderError(`quantity must be a whole number between 1 and ${MAX_QTY_PER_TYPE}`);
  }
  if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    throw new OrderError("A valid customerEmail is required");
  }
  if (!customerName?.trim()) throw new OrderError("customerName is required");
  if (!customerPhone?.trim()) throw new OrderError("customerPhone is required");

  const eventRef = adminDb.collection("events").doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw new OrderError("Event not found", 404);
  const event = eventSnap.data();

  if (event.suspended) throw new OrderError("This event is currently unavailable", 403);

  //  Virtual queue gate 
  // High-traffic events opt into a virtual queue (see v1/queue.js) that
  // only a real browser session on spotix.com.ng can join and hold a
  // checkout slot in. An AI chat model has no way to hold that slot, so
  // rather than silently let it skip the line, we refuse the purchase
  // outright and hand back the eventId — the MCP tool layer turns this
  // into the "please queue on the website" instruction for the user.
  if (event.virtualQueueEnabled) {
    throw new OrderError(
      "This event has a virtual queue enabled due to high demand — tickets can't be purchased through this assistant.",
      409,
      { queueRequired: true, eventId }
    );
  }

  const ticketPrices = Array.isArray(event.ticketPrices) ? event.ticketPrices : [];
  const ticketDoc = ticketPrices.find((t) => String(t.policy) === String(ticketType));
  if (!ticketDoc) throw new OrderError(`"${ticketType}" is not a valid ticket type for this event`, 404);

  const eventWideStop = { enabled: !!event.stopDate, stopDate: event.stopDate ?? null };
  const saleStatus = getTicketSaleStatus(ticketDoc, eventWideStop);
  if (!saleStatus.onSale) {
    throw new OrderError(`"${ticketType}" tickets aren't available right now — ${describeSaleStatus(saleStatus)}`);
  }

  const hasLimit = ticketDoc.availableTickets !== null && ticketDoc.availableTickets !== undefined && ticketDoc.availableTickets !== "";
  if (hasLimit && Number(ticketDoc.availableTickets) < quantity) {
    throw new OrderError(
      `Only ${Math.max(0, Number(ticketDoc.availableTickets) || 0)} "${ticketType}" ticket(s) remain — reduce the quantity`,
      409
    );
  }

  const canonicalPrice = Number(ticketDoc.price) || 0;

  const feeRates = resolvePlatformFeeRates(event);
  const feeBurden = resolveFeeBurden(event);

  const addonsSnap = await eventRef.collection("addons").get();
  const activeAddons = addonsSnap.docs
    .map((d) => d.data())
    .filter((a) => a.active !== false)
    .map((a) => ({
      name: a.name ?? "",
      pricePerTicket: typeof a.pricePerTicket === "number" ? a.pricePerTicket : 0,
      coveredBy: a.coveredBy === "organizer" ? "organizer" : "attendee",
    }));

  const ticketSubtotal = canonicalPrice * quantity;
  const spotixFeeTotal = calculateVATFee(canonicalPrice, feeRates) * quantity;

  const orderPricing = computeOrderPricing({
    ticketSubtotal,
    totalTicketCount: quantity,
    spotixFeeTotal,
    feeBurden,
    addons: activeAddons,
  });

  const timestamp = Date.now();
  const reference = buildTicketReference(timestamp);

  const paymentReference = {
    reference,
    userId: customerEmail,
    userEmail: customerEmail,
    userFullName: customerName.trim(),
    userPhone: customerPhone.trim(),
    eventId,
    eventCreatorId: event.organizerId,
    eventName: event.eventName ?? "",
    eventVenue: event.eventVenue ?? "",
    eventType: event.eventType ?? "",
    eventDate: event.eventDate ?? "",
    eventEndDate: event.eventEndDate ?? "",
    eventStart: event.eventStart ?? "",
    eventEnd: event.eventEnd ?? "",
    stopDate: event.stopDate ?? "",

    ticketTypes: [{ type: ticketType, quantity, price: canonicalPrice }],
    ticketType,
    ticketPrice: ticketSubtotal,
    totalAmount: orderPricing.totalPayable,
    transactionFee: orderPricing.spotixFeeTotal,
    appliedFeeRates: feeRates,
    feeBurden,
    buyerBearsBurden: !feeBurden.coversSpotixFee,
    paystackFee: orderPricing.paystackFeeTotal,
    paystackFeeChargedToBuyer: orderPricing.paystackFeeChargedToBuyer,
    organizerPaystackFeeCost: orderPricing.organizerPaystackFeeCost,
    appliedAddons: activeAddons,
    addonFeeTotal: orderPricing.addonFeeTotal,
    organizerAddonCostTotal: orderPricing.organizerAddonCostTotal,
    totalTicketCount: quantity,

    vendor: "paystack",
    status: "pending",
    channel: "mcp", // distinguishes MCP-originated orders in admin/analytics views
    paymentCreationDate: new Date().toISOString(),
    paymentCreationTimestamp: timestamp,

    discountCode: null,
    discountData: null,
    discountAmount: 0,
    referralCode: null,
    referralName: null,
    surveyResponses: null,

    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await adminDb.collection("Reference").doc(reference).set(paymentReference);

  //  Hand back the Spotix-hosted MCP payment page, not a Paystack link 
  // Same NEXT_PUBLIC_SPOTIX_URL spotix-mcp's own config.ts falls back to,
  // so this and the mcp server agree on the same default even if only one
  // of the two services has the var set.
  const spotixUrl = (process.env.NEXT_PUBLIC_SPOTIX_URL || process.env.APP_URL || "https://spotix.com.ng").replace(/\/+$/, "");
  const paymentLink = `${spotixUrl}/payment/mcp/${reference}`;

  return {
    reference,
    paymentLink,
    eventName: event.eventName,
    ticketType,
    quantity,
    currency: "NGN",
    totalAmount: orderPricing.totalPayable,
    breakdown: {
      ticketSubtotal,
      spotixFee: orderPricing.buyerOwesSpotixFee ? orderPricing.spotixFeeTotal : 0,
      paystackFee: orderPricing.paystackFeeChargedToBuyer,
      addonFee: orderPricing.addonFeeTotal,
    },
  };
}

/** Public-safe order/ticket lookup for verify_payment, post-reconciliation. */
export async function getOrder(reference) {
  const refSnap = await adminDb.collection("Reference").doc(reference).get();
  if (!refSnap.exists) throw new OrderError("Order not found", 404);
  const order = refSnap.data();

  const appUrl = process.env.APP_URL;
  const ticketIds = Array.isArray(order.ticketIds) ? order.ticketIds : [];
  const qrCodes = appUrl ? ticketIds.map((id) => `${appUrl}/v1/qrcode/${id}.png`) : [];

  return {
    reference,
    status: order.status ?? "pending",
    eventName: order.eventName ?? null,
    eventVenue: order.eventVenue ?? null,
    eventDate: order.eventDate ?? null,
    eventStart: order.eventStart ?? null,
    ticketType: order.ticketType ?? null,
    totalTicketCount: order.totalTicketCount ?? null,
    totalAmount: order.totalAmount ?? null,
    currency: "NGN",
    ticketIds,
    qrCodes,
    buyer: {
      name: order.userFullName ?? null,
      email: order.userEmail ?? null,
    },
  };
}
