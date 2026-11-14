// v1/lib/ticket/resend-tickets.js
//
// "I lost my ticket" self-service: given an event and either a buyer email or
// a payment reference, find that buyer's tickets in the event's register
// (events/{eventId}/attendees) and email ALL of the tickets they hold for
// this event — across every purchase — in ONE message, with ticket.pdf and
// invite.ics attached.
//
// The ticket is only ever emailed to the address already on the ticket,
// never to whoever typed the search, and the HTTP route answers identically
// whether or not anything was found (see v1/routes/ticket-resend.js), so
// this can't be used to read tickets or to probe who bought what.

import { adminDb } from "../../utils/firebase.js";
import { claimCooldown } from "../../middleware/rate-limit.js";
import { isValidTicketReference } from "../reference-format.js";
import { sendTicketEmail } from "./send-ticket-email.js";

// One email per (event, buyer) per window — stops the form being used to
// flood someone's inbox with their own tickets.
const RESEND_COOLDOWN_SECONDS = 5 * 60;
// Hard ceiling on tickets in one email (agents can bulk-buy). Newest are kept.
const MAX_TICKETS_PER_EMAIL = 100;

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** events/{id} by doc id, falling back to eventSlug (the public URL can carry either). */
async function resolveEvent(eventIdOrSlug) {
  const snap = await adminDb.collection("events").doc(eventIdOrSlug).get();
  if (snap.exists) return { id: snap.id, ...snap.data() };
  const bySlug = await adminDb.collection("events").where("eventSlug", "==", eventIdOrSlug).limit(1).get();
  if (bySlug.empty) return null;
  return { id: bySlug.docs[0].id, ...bySlug.docs[0].data() };
}

/**
 * Attendee `email` is stored exactly as the buyer typed it at checkout
 * (guest emails are only trimmed, never lower-cased), and Firestore equality
 * is case-sensitive — so look up the address as typed AND lower-cased.
 */
async function findTicketsByEmail(eventId, email) {
  const variants = [...new Set([email, email.toLowerCase()])];
  const snaps = await Promise.all(
    variants.map((v) => adminDb.collection("events").doc(eventId).collection("attendees").where("email", "==", v).limit(MAX_TICKETS_PER_EMAIL).get())
  );
  const byId = new Map();
  for (const snap of snaps) for (const d of snap.docs) byId.set(d.id, { id: d.id, ...d.data() });
  return [...byId.values()];
}

/**
 * @param {import("fastify").FastifyInstance} fastify
 * @param {{ eventId: string, query: string }} p - `query` is an email address or a ticket payment reference
 * @returns {Promise<{ sent: boolean, reason?: string, ticketCount?: number }>} for logging only — never shown to the requester
 */
export async function resendTicketsForEvent(fastify, { eventId, query }) {
  const input = String(query || "").trim();
  if (!input || !eventId) return { sent: false, reason: "empty" };

  const event = await resolveEvent(eventId);
  if (!event) return { sent: false, reason: "event_not_found" };

  // ── Work out whose tickets these are ──
  let buyerEmail;
  if (input.includes("@")) {
    if (!looksLikeEmail(input)) return { sent: false, reason: "invalid_email" };
    buyerEmail = input;
  } else {
    if (!isValidTicketReference(input)) return { sent: false, reason: "invalid_reference" };
    const refSnap = await adminDb
      .collection("events").doc(event.id).collection("attendees")
      .where("ticketReference", "==", input).limit(1).get();
    if (refSnap.empty) return { sent: false, reason: "reference_not_in_register" };
    buyerEmail = String(refSnap.docs[0].data().email || "").trim();
    if (!looksLikeEmail(buyerEmail)) return { sent: false, reason: "no_email_on_ticket" };
  }

  // ── Every ticket that address holds for this event ──
  const docs = await findTicketsByEmail(event.id, buyerEmail);
  if (docs.length === 0) return { sent: false, reason: "no_tickets" };

  const lowerEmail = buyerEmail.toLowerCase();
  const claimed = await claimCooldown("ticket-resend", `${event.id}:${lowerEmail}`, RESEND_COOLDOWN_SECONDS);
  if (!claimed) return { sent: false, reason: "cooldown" };

  // Oldest purchase first, ticket order within a purchase preserved by id sort as a stable tiebreak
  docs.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.id.localeCompare(b.id));
  const tickets = docs.slice(-MAX_TICKETS_PER_EMAIL).map((d) => ({
    ticketId: d.ticketId || d.id,
    ticketType: d.ticketType || "Standard",
  }));

  // ── Combined order summary across all purchases ──
  const typeCounts = new Map();
  for (const t of tickets) typeCounts.set(t.ticketType, (typeCounts.get(t.ticketType) || 0) + 1);
  const ticketTypesSummary = [...typeCounts].map(([type, n]) => `${type}${n > 1 ? ` x${n}` : ""}`).join(", ");

  // totalAmount on a ticket doc is the whole purchase's total, repeated on each of its tickets — count each reference once.
  const perReference = new Map();
  for (const d of docs) if (d.ticketReference && !perReference.has(d.ticketReference)) perReference.set(d.ticketReference, d);
  const references = [...perReference.keys()];
  const totalPaid = [...perReference.values()].reduce((sum, d) => sum + (Number(d.totalAmount) || 0), 0);
  const methods = [...new Set(docs.map((d) => d.paymentMethod).filter(Boolean))];

  const holderName = docs.map((d) => d.fullName).find((n) => n && String(n).trim()) || "Valued Customer";

  await sendTicketEmail({
    log: fastify.log,
    to: buyerEmail,
    name: holderName,
    subject: `Your Ticket${tickets.length > 1 ? "s" : ""} for ${event.eventName}`,
    eventId: event.id,
    eventName: event.eventName,
    eventHost: event.bookerName || "Event Host",
    eventImage: event.eventImage || "",
    eventVenue: event.eventVenue,
    eventDate: event.eventDate,
    eventEndDate: event.eventEndDate,
    eventStart: event.eventStart,
    eventEnd: event.eventEnd,
    paymentRef: references.join(", ") || "—",
    ticketTypesSummary,
    totalAmount: totalPaid.toFixed(2),
    ticketCount: tickets.length,
    paymentMethod: methods.join(", ") || "Paystack",
    bookerEmail: event.bookerEmail || "support@spotix.com.ng",
    tickets,
  });

  fastify.log.info(`[ticket-resend] Sent ${tickets.length} ticket(s) for event ${event.id} (${references.length} purchase(s))`);
  return { sent: true, ticketCount: tickets.length };
}
