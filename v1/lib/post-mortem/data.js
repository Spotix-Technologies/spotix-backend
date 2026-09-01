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
      purchaseDate: toDate(a.purchaseDate),
      checkedInAt: toDate(a.checkedInAt),
    };
  });
}
