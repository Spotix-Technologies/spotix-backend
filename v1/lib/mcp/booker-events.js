// v1/lib/mcp/booker-events.js
//
// Logic behind the authenticated (Bearer MCP token) booker-management
// routes in v1/mcp-booker.js: my_events, my_event_stats, discount and
// referral management, and share_event. Every function here takes the
// CALLER'S uid (resolved from the verified MCP access token — see
// v1/lib/mcp-oauth/store.js's verifyAccessToken) as its first argument
// and enforces strict ownership: organizerId === uid, full stop. Unlike
// spotix-booker's own event-info routes, there is deliberately NO
// collaborator/Admin parity path here — an MCP client only ever acts as
// the connected booker themselves, never as someone they've been added
// to an event's team by, keeping the trust boundary a single straight
// line from "whose token is this" to "whose event is this".
//
// Discount validation (90% caps) and slug rules mirror
// spotix-booker's app/api/event/list/[eventId]/route.ts and
// app/lib/slug.ts exactly — same "conscious duplication" precedent as
// the rest of v1/lib/mcp/, so a discount or link created via an AI chat
// client is governed by identical rules to one created by hand on the
// dashboard.

import { adminDb } from "../../utils/firebase.js";
import { FieldValue } from "firebase-admin/firestore";
import { slugify, isValidSlug, withSuffix, SLUG_RULES_HINT } from "./slug.js";

export class BookerEventsError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

const MAX_EVENTS_LISTED = 50;

// ── Ownership resolution ─────────────────────────────────────────────────────

async function resolveOwnedEvent(uid, eventId) {
  if (!eventId) throw new BookerEventsError("eventId is required", 400);
  const eventRef = adminDb.collection("events").doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw new BookerEventsError("Event not found", 404);
  const data = eventSnap.data();
  if (data.organizerId !== uid) {
    throw new BookerEventsError("You don't own this event, so it isn't accessible through this connection", 403);
  }
  return { eventRef, eventSnap, data };
}

function eventTicketPrices(data) {
  return (Array.isArray(data.ticketPrices) ? data.ticketPrices : [])
    .filter((t) => t?.policy)
    .map((t) => ({ policy: t.policy, price: Number(t.price) || 0 }));
}

function shapeEventSummary(id, data, now) {
  const eventDate = data.eventDate?.toDate?.() ?? new Date(data.eventDate);
  const isPast = eventDate < now;
  const status =
    data.status === "cancelled" ? "cancelled" : data.status === "completed" ? "completed" : data.status === "inactive" ? "inactive" : isPast ? "past" : "active";

  return {
    eventId: id,
    eventName: data.eventName ?? "Unnamed Event",
    eventSlug: data.eventSlug ?? null,
    eventDate: isNaN(eventDate.getTime()) ? null : eventDate.toISOString(),
    eventVenue: data.eventVenue ?? "No venue specified",
    eventType: data.eventType ?? "Other",
    isFree: data.isFree ?? false,
    ticketsSold: data.ticketsSold ?? 0,
    totalRevenue: data.totalRevenue ?? 0,
    status,
  };
}

// ── my_events ────────────────────────────────────────────────────────────────

/** Lists every event owned by `uid`. `eventId` narrows to a single event
 *  (and still enforces ownership) — this is the "verify ownership" path
 *  the my_events tool exposes for "is this my event / can I manage it". */
export async function listMyEvents(uid, eventId) {
  if (eventId) {
    const { data } = await resolveOwnedEvent(uid, eventId);
    return { events: [shapeEventSummary(eventId, data, new Date())] };
  }

  const snap = await adminDb.collection("events").where("organizerId", "==", uid).limit(MAX_EVENTS_LISTED).get();
  const now = new Date();
  const events = snap.docs
    .map((d) => shapeEventSummary(d.id, d.data(), now))
    .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
  return { events };
}

// ── my_event_stats ──────────────────────────────────────────────────────────

/**
 * Ticket-type breakdown + revenue/payout figures for one event. Mirrors
 * spotix-booker's app/lib/event-bundle.ts ticketSalesByType computation
 * (one count() aggregation per ticket policy — cheap, no attendee-doc
 * scan) so the numbers an AI chat client reports match the dashboard's
 * Overview tab exactly.
 */
export async function getMyEventStats(uid, eventId) {
  const { eventRef, data } = await resolveOwnedEvent(uid, eventId);

  const policies = eventTicketPrices(data);
  const counts = await Promise.all(
    policies.map((t) => eventRef.collection("attendees").where("ticketType", "==", t.policy).count().get())
  );
  const ticketTypeStats = policies.map((t, i) => {
    const sold = counts[i].data().count;
    return { ticketType: t.policy, price: t.price, sold, revenue: sold * t.price };
  });

  const calculatedRevenue = ticketTypeStats.reduce((sum, t) => sum + t.revenue, 0);
  const totalRevenue = data.totalRevenue ?? data.revenue ?? calculatedRevenue ?? 0;

  let calculatedPaidOut = 0;
  try {
    const payoutsSnap = await eventRef.collection("payouts").where("status", "==", "Confirmed").get();
    calculatedPaidOut = payoutsSnap.docs.reduce((sum, d) => sum + (d.data().payoutAmount ?? 0), 0);
  } catch {
    // Non-fatal — falls back to the event doc's own running total below.
  }
  const totalPaidOut = data.totalPaidOut ?? calculatedPaidOut;
  const availableRevenue = data.availableRevenue ?? totalRevenue - totalPaidOut;

  return {
    eventId,
    eventName: data.eventName ?? "",
    currency: "NGN",
    totalTicketsSold: data.ticketsSold ?? ticketTypeStats.reduce((s, t) => s + t.sold, 0),
    ticketTypeStats,
    totalRevenue,
    totalPaidOut,
    availableToPayOut: availableRevenue,
  };
}

// ── Discounts ────────────────────────────────────────────────────────────────

function maxApplicablePrice(ticketPrices, applicableTickets) {
  const relevant =
    applicableTickets && applicableTickets.length > 0
      ? ticketPrices.filter((t) => applicableTickets.includes(t.policy))
      : ticketPrices;
  return relevant.reduce((max, t) => Math.max(max, t.price), 0);
}

function validateDiscountValue(type, value, ticketPrices, applicableTickets) {
  if (type === "percentage") {
    if (value > 90) return "Percentage discounts can't exceed 90%.";
    return null;
  }
  const maxPrice = maxApplicablePrice(ticketPrices, applicableTickets);
  if (maxPrice <= 0) return "This event has no priced ticket tiers to discount.";
  if (value > maxPrice) {
    return `There's no ticket listed that costs that much — the highest applicable ticket is ₦${maxPrice.toLocaleString("en-NG")}.`;
  }
  const cap = maxPrice * 0.9;
  if (value > cap) {
    return `A flat discount can't give away more than 90% of the highest applicable ticket price (₦${cap.toLocaleString("en-NG")}).`;
  }
  return null;
}

function shapeDiscount(doc) {
  const d = doc.data();
  return {
    discountId: doc.id,
    code: d.code,
    type: d.type,
    value: d.value,
    maxUses: d.maxUses ?? 1,
    usedCount: d.usedCount ?? 0,
    active: d.active !== false,
    expiryDate: d.expiryDate ?? null,
    applicableTickets: d.applicableTickets ?? null,
  };
}

/** `code` narrows to one discount (exact match, case-insensitive) — the
 *  "specify a code directly to get its details" path. */
export async function listDiscounts(uid, eventId, code) {
  const { eventRef } = await resolveOwnedEvent(uid, eventId);
  const snap = await eventRef.collection("discounts").get();

  if (code) {
    const match = snap.docs.find((d) => d.data().code?.toLowerCase() === code.trim().toLowerCase());
    if (!match) throw new BookerEventsError(`No discount code "${code}" exists on this event`, 404);
    return { discounts: [shapeDiscount(match)] };
  }

  return { discounts: snap.docs.map(shapeDiscount) };
}

/** input: { code, type, value, maxUses?, expiryDate?, applicableTickets? } */
export async function createDiscount(uid, eventId, input) {
  const { eventRef, data } = await resolveOwnedEvent(uid, eventId);
  const { code, type, value, maxUses, expiryDate, applicableTickets } = input;

  if (!code?.trim()) throw new BookerEventsError("code is required");
  if (!["percentage", "flat"].includes(type)) throw new BookerEventsError("type must be 'percentage' or 'flat'");
  if (typeof value !== "number" || value < 0) throw new BookerEventsError("value must be a non-negative number");

  const ticketPrices = eventTicketPrices(data);

  const existingAll = await eventRef.collection("discounts").get();
  const duplicate = existingAll.docs.some((d) => d.data().code?.toLowerCase() === code.trim().toLowerCase());
  if (duplicate) throw new BookerEventsError("A discount with this code already exists", 409);

  let normalizedApplicableTickets = null;
  if (Array.isArray(applicableTickets) && applicableTickets.length > 0) {
    const eventPolicies = ticketPrices.map((t) => t.policy);
    const invalid = applicableTickets.filter((t) => !eventPolicies.includes(t));
    if (invalid.length > 0) throw new BookerEventsError(`Unknown ticket type(s): ${invalid.join(", ")}`);
    normalizedApplicableTickets = applicableTickets;
  }

  const valueError = validateDiscountValue(type, value, ticketPrices, normalizedApplicableTickets);
  if (valueError) throw new BookerEventsError(valueError);

  let normalizedExpiryDate = null;
  if (expiryDate) {
    const parsed = new Date(expiryDate);
    if (Number.isNaN(parsed.getTime())) throw new BookerEventsError("expiryDate must be a valid date");
    normalizedExpiryDate = parsed.toISOString();
  }

  const doc = {
    code: code.trim(),
    type,
    value,
    maxUses: maxUses ?? 1,
    usedCount: 0,
    active: true,
    expiryDate: normalizedExpiryDate,
    applicableTickets: normalizedApplicableTickets,
    createdAt: FieldValue.serverTimestamp(),
    createdVia: "mcp",
  };

  const docRef = await eventRef.collection("discounts").add(doc);
  return { discount: { discountId: docRef.id, ...doc, createdAt: undefined } };
}

/** Deactivates (never deletes) a discount by code or discountId — one of
 *  the two must be given. Mirrors the dashboard's toggle behaviour but
 *  is one-directional here: the MCP surface only ever turns a code OFF,
 *  never back on, since re-activating pricing/promo terms is a decision
 *  best made on the dashboard where the booker can see full context. */
export async function deactivateDiscount(uid, eventId, { discountId, code } = {}) {
  const { eventRef } = await resolveOwnedEvent(uid, eventId);
  if (!discountId && !code) throw new BookerEventsError("discountId or code is required");

  let discountRef;
  if (discountId) {
    discountRef = eventRef.collection("discounts").doc(discountId);
    const snap = await discountRef.get();
    if (!snap.exists) throw new BookerEventsError("Discount not found", 404);
  } else {
    const snap = await eventRef.collection("discounts").get();
    const match = snap.docs.find((d) => d.data().code?.toLowerCase() === code.trim().toLowerCase());
    if (!match) throw new BookerEventsError(`No discount code "${code}" exists on this event`, 404);
    discountRef = match.ref;
  }

  await discountRef.update({ active: false, updatedAt: FieldValue.serverTimestamp() });
  const fresh = await discountRef.get();
  return { discount: shapeDiscount(fresh) };
}

// ── Referrals ────────────────────────────────────────────────────────────────

function shapeReferral(doc, usages) {
  const d = doc.data();
  return {
    code: doc.id,
    totalTickets: d.totalTickets ?? (usages ? usages.length : 0),
    usages: usages ?? undefined,
  };
}

/** `code` narrows to one referral code's usage history. */
export async function listReferrals(uid, eventId, code) {
  const { eventRef } = await resolveOwnedEvent(uid, eventId);

  if (code) {
    const ref = eventRef.collection("referrals").doc(code.trim());
    const snap = await ref.get();
    if (!snap.exists) throw new BookerEventsError(`No referral code "${code}" exists on this event`, 404);
    const usagesSnap = await ref.collection("usages").orderBy("purchaseDate", "desc").get().catch(() => ref.collection("usages").get());
    const usages = usagesSnap.docs.map((u) => {
      const ud = u.data();
      return { name: ud.name ?? "Unknown", ticketType: ud.ticketType ?? "Standard", purchaseDate: ud.purchaseDate ?? null };
    });
    return { referrals: [shapeReferral(snap, usages)] };
  }

  const snap = await eventRef.collection("referrals").get();
  return { referrals: snap.docs.map((d) => shapeReferral(d)) };
}

export async function createReferral(uid, eventId, code) {
  const { eventRef } = await resolveOwnedEvent(uid, eventId);
  if (!code?.trim()) throw new BookerEventsError("code is required");
  if (/\s/.test(code.trim())) throw new BookerEventsError("Referral code cannot contain spaces");

  const referralsRef = eventRef.collection("referrals");
  const allDocs = await referralsRef.get();
  const duplicate = allDocs.docs.some((d) => d.id.toLowerCase() === code.trim().toLowerCase());
  if (duplicate) throw new BookerEventsError("This referral code already exists", 409);

  await referralsRef.doc(code.trim()).set({
    totalTickets: 0,
    createdAt: FieldValue.serverTimestamp(),
    createdVia: "mcp",
  });

  return { referral: { code: code.trim(), totalTickets: 0, usages: [] } };
}

// ── share_event ──────────────────────────────────────────────────────────────

const SPOTIX_USER_BASE = (process.env.PUBLIC_SPOTIX_URL || process.env.APP_URL || "https://spotix.com.ng").replace(/\/+$/, "");

/**
 * Returns the shareable event link. If the event has no slug yet and
 * `desiredSlug` wasn't given, this does NOT error — it returns
 * `needsSlug: true` with no link, so the calling tool can relay that to
 * the AI model, which asks the booker what they'd like their link to
 * say and calls this again with `desiredSlug` set.
 */
export async function shareEvent(uid, eventId, desiredSlug) {
  const { eventRef, data } = await resolveOwnedEvent(uid, eventId);

  if (data.eventSlug) {
    return { eventId, eventSlug: data.eventSlug, eventUrl: `${SPOTIX_USER_BASE}/event/${data.eventSlug}`, needsSlug: false };
  }

  if (!desiredSlug) {
    return { eventId, eventSlug: null, eventUrl: null, needsSlug: true };
  }

  const baseSlug = slugify(desiredSlug);
  if (!isValidSlug(baseSlug)) throw new BookerEventsError(`Invalid link — ${SLUG_RULES_HINT}`);

  let finalSlug = baseSlug;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const candidate = withSuffix(baseSlug, attempt);
    const existing = await adminDb.collection("events").where("eventSlug", "==", candidate).limit(1).get();
    const takenByAnother = !existing.empty && existing.docs[0].id !== eventId;
    if (!takenByAnother) {
      finalSlug = candidate;
      break;
    }
    if (attempt === 5) finalSlug = withSuffix(baseSlug, Date.now() % 100000);
  }

  await eventRef.update({ eventSlug: finalSlug, updatedAt: FieldValue.serverTimestamp() });
  return { eventId, eventSlug: finalSlug, eventUrl: `${SPOTIX_USER_BASE}/event/${finalSlug}`, needsSlug: false };
}
