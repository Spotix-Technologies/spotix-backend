// v1/lib/mcp/events-cache.js
//
// Read-through cache for the "active events" snapshot search_events
// filters/ranks in memory. Firestore has no good native full-text
// search, so rather than run a bespoke compound query per request, we
// pull the bounded set of live events once every EVENTS_CACHE_TTL
// seconds and let v1/mcp/events.js do the matching — same tradeoff
// already made elsewhere in this backend (see v1/lib/queue/config.js's
// Firestore-read-shielding cache).
//
// Cache is intentionally short-lived: long enough to absorb a burst of
// searches from one chat session, short enough that a newly-published
// event or a sold-out tier shows up again within the minute.

import { adminDb } from "../../utils/firebase.js";
import { redis } from "../../utils/redis-client.js";

const EVENTS_CACHE_KEY = "mcp:events:snapshot";
const EVENTS_CACHE_TTL_SECONDS = 90;

// Cap on how many live events we ever pull from Firestore in one go —
// protects both Firestore quota and the in-memory filter step. Events
// beyond this (ordered by soonest eventDate first) simply won't be
// search-indexed by the MCP until older ones pass.
const MAX_EVENTS_SCANNED = 500;

function toPublicEventShape(doc) {
  const d = doc.data();
  return {
    eventId: doc.id,
    eventName: d.eventName ?? "",
    eventSlug: d.eventSlug ?? null,
    eventDescription: d.eventDescription ?? "",
    eventImage: d.eventImage ?? null,
    eventImages: Array.isArray(d.eventImages) ? d.eventImages : [],
    eventDate: d.eventDate ?? null,
    eventEndDate: d.eventEndDate ?? null,
    eventStart: d.eventStart ?? null,
    eventEnd: d.eventEnd ?? null,
    eventVenue: d.eventVenue ?? "",
    country: d.country ?? null,
    state: d.state ?? null,
    eventType: d.eventType ?? null,
    isFree: !!d.isFree,
    ticketPrices: Array.isArray(d.ticketPrices) ? d.ticketPrices : [],
    virtualQueueEnabled: !!d.virtualQueueEnabled,
    suspended: !!d.suspended,
    status: d.status ?? "active",
  };
}

async function fetchFreshSnapshot(fastify) {
  const snap = await adminDb
    .collection("events")
    .orderBy("eventDate", "asc")
    .limit(MAX_EVENTS_SCANNED)
    .get();

  const events = snap.docs
    .map(toPublicEventShape)
    .filter((e) => !e.suspended && e.status !== "cancelled" && e.status !== "deleted");

  try {
    await redis.set(EVENTS_CACHE_KEY, JSON.stringify(events), { ex: EVENTS_CACHE_TTL_SECONDS });
  } catch (err) {
    fastify?.log?.warn?.("[mcp/events-cache] Redis write failed (non-blocking):", err?.message);
  }

  return events;
}

/** Returns the cached snapshot, refreshing from Firestore on a miss. */
export async function getEventsSnapshot(fastify) {
  try {
    const cached = await redis.get(EVENTS_CACHE_KEY);
    if (cached) {
      return typeof cached === "string" ? JSON.parse(cached) : cached;
    }
  } catch (err) {
    fastify?.log?.warn?.("[mcp/events-cache] Redis read failed, falling back to Firestore:", err?.message);
  }
  return fetchFreshSnapshot(fastify);
}
