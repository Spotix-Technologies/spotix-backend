// v1/lib/post-mortem/data.js
//
// Firestore reads for the Attendee Post Mortem feature. Reads directly via
// this backend's own adminDb (same Firebase project spotix-booker uses) —
// the whole point of building this in spotix-backend rather than booker is
// that the heavy lifting (full roster read, PDF render) shouldn't block a
// Next.js API route or run on booker's request/response cycle.

import { adminDb } from "../../firebase-admin.js";

/** Normalizes a Firestore Timestamp, ISO string, epoch number, or
 *  null/undefined into a JS Date (or null if it can't be parsed). */
function toDate(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value?.toDate === "function") {
    try {
      const d = value.toDate();
      return isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  }
  return null;
}

/** Combines the attendee doc's separate `purchaseDate` and `purchaseTime`
 *  fields (see v1/lib/ticket/write-tickets.js — written as
 *  `new Date(nowIso).toLocaleDateString()` / `.toLocaleTimeString()`, two
 *  locale-formatted strings, not one timestamp) into a single accurate
 *  Date. Reading `purchaseDate` alone — what this used to do — parses to
 *  midnight every time, which is why every "Purchased" row in the PDF
 *  showed 0:00 regardless of when the ticket actually sold.
 *  `toLocaleDateString()` + ", " + `toLocaleTimeString()` reconstructs
 *  exactly the format `Date.prototype.toLocaleString()` itself produces,
 *  which `new Date(...)` can parse back. Falls back to `purchaseDate`
 *  alone (old behavior) if the combined string doesn't parse, and to
 *  `createdAt` (an ISO string on the same doc) if neither works. */
function purchaseDateTime(a) {
  if (a.purchaseDate && a.purchaseTime) {
    const combined = new Date(`${a.purchaseDate}, ${a.purchaseTime}`);
    if (!isNaN(combined.getTime())) return combined;
  }
  const dateOnly = toDate(a.purchaseDate);
  if (dateOnly) return dateOnly;
  return toDate(a.createdAt);
}

/** Ticket Price = the price of THIS ticket, per write-tickets.js
 *  (`ticketPrice: seat.price`, written once per ticket doc). This is
 *  distinct from `totalAmount`, which is the whole order's total and is
 *  written identically onto every ticket doc created from that order —
 *  reading `totalAmount` for a 2-ticket order attributes the full order
 *  total (e.g. ₦10,000) to each individual ticket instead of its actual
 *  ₦5,000 price. Returns null (not 0) when ticketPrice is missing so the
 *  PDF can render "—" instead of a misleading ₦0. */
function ticketPriceOf(a) {
  const price = Number(a.ticketPrice);
  return Number.isFinite(price) ? price : null;
}

export async function fetchEventForPostMortem(eventId) {
  const eventSnap = await adminDb.collection("events").doc(eventId).get();
  if (!eventSnap.exists) return null;
  const ev = eventSnap.data() || {};

  return {
    id: eventId,
    eventName: ev.eventName || "Untitled Event",
    eventVenue: ev.eventVenue || "",
    eventDate: ev.eventDate || "",
    eventEndDate: ev.eventEndDate || "",
    eventStart: ev.eventStart || "",
    eventEnd: ev.eventEnd || "",
    organizerId: ev.organizerId || "",
  };
}

/** True once the event's end date+time is in the past. Backend's own
 *  safety check — booker already gates the button on this, but the
 *  generation pipeline shouldn't trust the caller alone. */
export function hasEventEnded(event) {
  if (!event?.eventEndDate || !event?.eventEnd) return false;
  const end = new Date(`${event.eventEndDate}T${event.eventEnd}`);
  if (isNaN(end.getTime())) return false;
  return Date.now() > end.getTime();
}

export async function fetchAttendeesForPostMortem(eventId) {
  const snap = await adminDb.collection("events").doc(eventId).collection("attendees").get();

  return snap.docs.map((d) => {
    const a = d.data() || {};
    return {
      id: d.id,
      fullName: a.fullName || "Unknown",
      email: (a.email || "unknown@spotix.com.ng").toLowerCase(),
      ticketType: a.ticketType || "Standard",
      ticketReference: a.ticketReference || d.id,
      verified: a.verified === true,
      purchaseDate: purchaseDateTime(a),
      checkedInAt: toDate(a.checkedInAt),
      ticketPrice: ticketPriceOf(a),
      discountApplied: a.discountApplied === true,
      discountCode: a.discountCode || null,
      referralCode: a.referralCode || null,
      referralName: a.referralName || null,
    };
  });
}

/** events/{eventId}/referrals/{code} — the canonical source for referral
 *  usage counts. Each doc's `totalTickets` is a running counter
 *  incremented atomically at purchase time (see v1/lib/ticket/referral.js)
 *  and is the number to use for "top referrers" — NOT a tally of
 *  attendee docs' `referralCode` field, and NOT anything derived from
 *  `totalAmount`/order totals. Returns codes with at least one ticket,
 *  sorted highest first. */
export async function fetchReferralsForPostMortem(eventId) {
  const snap = await adminDb.collection("events").doc(eventId).collection("referrals").get();

  return snap.docs
    .map((d) => {
      const r = d.data() || {};
      return {
        code: d.id,
        totalTickets: Number.isFinite(Number(r.totalTickets)) ? Number(r.totalTickets) : 0,
      };
    })
    .filter((r) => r.totalTickets > 0)
    .sort((a, b) => b.totalTickets - a.totalTickets);
}

/** events/{eventId}/questions — the organizer's survey form, if any (see
 *  spotix-booker's app/api/survey/route.ts / form-tab.tsx). Ordered same
 *  as the booker form-builder UI shows them. */
export async function fetchSurveyQuestionsForPostMortem(eventId) {
  const snap = await adminDb
    .collection("events")
    .doc(eventId)
    .collection("questions")
    .orderBy("order")
    .get();

  return snap.docs.map((d) => {
    const q = d.data() || {};
    return {
      id: d.id,
      questionText: q.questionText || "Untitled question",
      questionType: q.questionType || "short",
      options: Array.isArray(q.options) ? q.options : [],
      required: q.required === true,
    };
  });
}

/** events/{eventId}/responses — one doc per buyer submission, delivered
 *  post-payment by spotix-backend's own survey-delivery.js (see that
 *  file's header comment for why it's delivered from here rather than
 *  the frontend). `responses` is keyed by questionId: a string for
 *  short/long/number/phone/date/time/datetime and radio, an array of
 *  strings for checkbox. */
export async function fetchSurveyResponsesForPostMortem(eventId) {
  const snap = await adminDb.collection("events").doc(eventId).collection("responses").get();

  return snap.docs.map((d) => {
    const r = d.data() || {};
    return {
      id: d.id,
      responses: r.responses && typeof r.responses === "object" ? r.responses : {},
      attendeeInfo: {
        fullName: r.attendeeInfo?.fullName || "Unknown",
        email: r.attendeeInfo?.email || "",
        ticketType: r.attendeeInfo?.ticketType || "",
      },
      submittedAt: toDate(r.submittedAt),
    };
  });
}
