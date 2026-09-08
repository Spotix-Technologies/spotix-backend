// v1/lib/mcp/events.js
//
// search_events matching/ranking logic. Called by v1/mcp.js's
// GET /mcp/events route. Filters + scores the cached events snapshot
// (see events-cache.js) against whatever the AI model passed —
// eventName is fuzzy/substring, dates/state/country are hard filters
// since a physically-wrong-state or already-past-window result is never
// a "best match", just a wrong one.

import { getEventsSnapshot } from "./events-cache.js";

const MAX_RESULTS = 10;
const MAX_IMAGES_PER_EVENT = 10;

function normalize(str) {
  return String(str ?? "").trim().toLowerCase();
}

/** True if the event's [eventDate, eventEndDate] window overlaps [from, to]. */
function overlapsDateRange(event, from, to) {
  if (!from && !to) return true;
  const evStart = event.eventDate;
  const evEnd = event.eventEndDate || event.eventDate;
  if (!evStart) return true; // don't punish sparse data — let name/location carry it
  if (from && evEnd && evEnd < from) return false;
  if (to && evStart && evStart > to) return false;
  return true;
}

function scoreEvent(event, filters) {
  let score = 0;

  if (filters.name) {
    const name = normalize(event.eventName);
    const q = filters.name;
    if (name === q) score += 100;
    else if (name.startsWith(q)) score += 60;
    else if (name.includes(q)) score += 40;
    else if (normalize(event.eventDescription).includes(q)) score += 10;
    else return null; // name was asked for and doesn't match anywhere relevant
  }

  if (filters.state) {
    if (normalize(event.state) !== filters.state) return null;
    score += 25;
  }
  if (filters.country) {
    if (normalize(event.country) !== filters.country) return null;
    score += 15;
  }
  if (filters.venue) {
    if (!normalize(event.eventVenue).includes(filters.venue)) return null;
    score += 20;
  }
  if (filters.eventType) {
    if (normalize(event.eventType) !== filters.eventType) return null;
    score += 10;
  }

  if (!overlapsDateRange(event, filters.startDate, filters.endDate)) return null;
  if (filters.startDate || filters.endDate) score += 10;

  // Soonest-first tiebreaker nudge — small enough to never override a
  // real relevance signal above, just orders otherwise-equal matches.
  score += event.eventDate ? 1 / (1 + Math.abs(new Date(event.eventDate).getTime())) : 0;

  return score;
}

function toSearchResult(event) {
  const images = [event.eventImage, ...event.eventImages].filter(Boolean).slice(0, MAX_IMAGES_PER_EVENT);
  return {
    eventId: event.eventId,
    eventName: event.eventName,
    eventSlug: event.eventSlug,
    eventDescription: event.eventDescription,
    images,
    eventDate: event.eventDate,
    eventEndDate: event.eventEndDate,
    eventStart: event.eventStart,
    eventEnd: event.eventEnd,
    eventVenue: event.eventVenue,
    country: event.country,
    state: event.state,
    eventType: event.eventType,
    isFree: event.isFree,
    ticketTypeCount: event.ticketPrices.length,
    priceRange: event.isFree
      ? null
      : event.ticketPrices.length
      ? {
          min: Math.min(...event.ticketPrices.map((t) => Number(t.price) || 0)),
          max: Math.max(...event.ticketPrices.map((t) => Number(t.price) || 0)),
          currency: "NGN",
        }
      : null,
    virtualQueueEnabled: event.virtualQueueEnabled,
  };
}

/**
 * filters: { name?, startDate?, endDate?, state?, country?, venue?, eventType? }
 * All date filters are "YYYY-MM-DD" strings (same shape stored on the event doc).
 */
export async function searchEvents(fastify, filters) {
  const snapshot = await getEventsSnapshot(fastify);

  const normalizedFilters = {
    name: filters.name ? normalize(filters.name) : null,
    state: filters.state ? normalize(filters.state) : null,
    country: filters.country ? normalize(filters.country) : null,
    venue: filters.venue ? normalize(filters.venue) : null,
    eventType: filters.eventType ? normalize(filters.eventType) : null,
    startDate: filters.startDate || null,
    endDate: filters.endDate || null,
  };

  const scored = [];
  for (const event of snapshot) {
    const score = scoreEvent(event, normalizedFilters);
    if (score === null) continue;
    scored.push({ event, score });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_RESULTS).map((s) => toSearchResult(s.event));
}
