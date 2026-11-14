// v1/lib/ticket/calendar-invite.js
//
// Builds the "invite.ics" attached to ticket emails, so Gmail / Apple Mail /
// Outlook show an "Add to Calendar" card, plus the human-readable
// "Fri, Dec 4, 2026 · 1:00 PM – Sat, Dec 5, 2026 · 6:00 PM" line used in the
// email body and the ticket PDF. No dependencies — an .ics file is just text.
//
// Event dates are stored on events/{id} (and copied onto Reference/tickets
// docs at checkout) as strings: eventDate / eventEndDate = "YYYY-MM-DD"
// (an ISO string is tolerated too) and eventStart / eventEnd = 24h "HH:mm".
// There is no timezone field — every event is a Nigerian event, so the
// wall-clock times are treated as Africa/Lagos (UTC+1, no daylight saving).
// Mirrors the rules in spotix-user's event/[eventId]/lib/event-datetime.ts.

import { COMPANY } from "../mail/email-brand.js";

const LAGOS_UTC_OFFSET_HOURS = 1;
const DEFAULT_DURATION_HOURS = 3; // start time but no end time — same fallback as the "Add to Google Calendar" link
const pad = (n) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" | ISO string | Firestore Timestamp-ish -> { y, m, d } (Lagos calendar day) or null */
function parseDay(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (ymd) return { y: Number(ymd[1]), m: Number(ymd[2]), d: Number(ymd[3]) };
  }
  let date;
  if (typeof value === "object" && value !== null) {
    const seconds = value.seconds ?? value._seconds;
    date = typeof seconds === "number" ? new Date(seconds * 1000) : new Date(value);
  } else {
    date = new Date(value);
  }
  if (Number.isNaN(date.getTime())) return null;
  const lagos = new Date(date.getTime() + LAGOS_UTC_OFFSET_HOURS * 3600 * 1000);
  return { y: lagos.getUTCFullYear(), m: lagos.getUTCMonth() + 1, d: lagos.getUTCDate() };
}

function parseTime(value) {
  const m = typeof value === "string" ? /^(\d{1,2}):(\d{2})/.exec(value.trim()) : null;
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh > 23 || mm > 59 ? null : { hh, mm };
}

// Wall-clock fields as a UTC-based Date. Used for arithmetic and formatting
// only — the "UTC" here is just a timezone-free container, not a real zone.
const wallToDate = ({ y, m, d }, t) => new Date(Date.UTC(y, m - 1, d, t?.hh ?? 0, t?.mm ?? 0));

/**
 * @returns {null | { allDay: boolean, start: Date, end: Date }}
 *   `start`/`end` are wall-clock Dates (see wallToDate). For all-day events
 *   `end` is the last day itself (inclusive).
 */
function resolveEventWindow({ eventDate, eventStart, eventEndDate, eventEnd }) {
  const startDay = parseDay(eventDate);
  if (!startDay) return null;
  const startTime = parseTime(eventStart);
  const endDay = parseDay(eventEndDate) || startDay;
  const endTime = parseTime(eventEnd);

  if (!startTime) {
    return { allDay: true, start: wallToDate(startDay), end: wallToDate(endDay) };
  }

  const start = wallToDate(startDay, startTime);
  let end = endTime
    ? wallToDate(endDay, endTime)
    : new Date(start.getTime() + DEFAULT_DURATION_HOURS * 3600 * 1000);
  // Overnight event with no explicit end date (e.g. 22:00 -> 04:00)
  if (end <= start) end = new Date(end.getTime() + 24 * 3600 * 1000);
  return { allDay: false, start, end };
}

const fmtDay = (date) =>
  date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function fmtClock(date) {
  const h = date.getUTCHours();
  return `${h % 12 || 12}:${pad(date.getUTCMinutes())} ${h >= 12 ? "PM" : "AM"}`;
}

/**
 * Human-readable event time for emails / the PDF ("" when the event has no
 * usable date). e.g. "Fri, Dec 4, 2026 · 1:00 PM – Sat, Dec 5, 2026 · 6:00 PM".
 */
export function formatEventWhen(fields) {
  const w = resolveEventWindow(fields || {});
  if (!w) return "";
  const sameDay = w.start.toISOString().slice(0, 10) === w.end.toISOString().slice(0, 10);
  if (w.allDay) return sameDay ? fmtDay(w.start) : `${fmtDay(w.start)} – ${fmtDay(w.end)}`;
  if (sameDay) return `${fmtDay(w.start)} · ${fmtClock(w.start)} – ${fmtClock(w.end)}`;
  return `${fmtDay(w.start)} · ${fmtClock(w.start)} – ${fmtDay(w.end)} · ${fmtClock(w.end)}`;
}

// ── iCalendar (RFC 5545) text helpers ───────────────────────────────────────

const icsEscape = (s) =>
  String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

/** Folds a content line to <=75 octets per physical line (never splitting a UTF-8 character). */
function foldLine(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const out = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74; // continuation lines start with one space
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const stampUtc = (date) =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;

const wallToUtcStamp = (wall) =>
  stampUtc(new Date(wall.getTime() - LAGOS_UTC_OFFSET_HOURS * 3600 * 1000));

const dayStamp = (date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;

/**
 * @param {Object} p
 * @param {string} p.uid - stable per (event, purchase) so re-sent emails update the calendar entry instead of duplicating it
 * @param {string} p.title
 * @param {string} [p.location]
 * @param {string} [p.description]
 * @param {string} [p.url]
 * @param {string} [p.eventDate] / p.eventStart / p.eventEndDate / p.eventEnd - see top of file
 * @returns {string|null} the .ics text, or null when the event has no usable date
 */
export function buildCalendarInvite({ uid, title, location, description, url, eventDate, eventStart, eventEndDate, eventEnd }) {
  const w = resolveEventWindow({ eventDate, eventStart, eventEndDate, eventEnd });
  if (!w) return null;

  const dateLines = w.allDay
    ? [
        `DTSTART;VALUE=DATE:${dayStamp(w.start)}`,
        `DTEND;VALUE=DATE:${dayStamp(new Date(w.end.getTime() + 24 * 3600 * 1000))}`, // all-day DTEND is exclusive
      ]
    : [`DTSTART:${wallToUtcStamp(w.start)}`, `DTEND:${wallToUtcStamp(w.end)}`];

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Spotix Technologies//Spotix Tickets//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEscape(uid)}`,
    `DTSTAMP:${stampUtc(new Date())}`,
    ...dateLines,
    `SUMMARY:${icsEscape(title)}`,
    ...(location ? [`LOCATION:${icsEscape(location)}`] : []),
    ...(description ? [`DESCRIPTION:${icsEscape(description)}`] : []),
    ...(url ? [`URL:${url}`] : []),
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "BEGIN:VALARM",
    "TRIGGER:-P1D",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(`Tomorrow: ${title}`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

export const eventPageUrl = (eventId) => (eventId ? `${COMPANY.siteUrl}/event/${encodeURIComponent(eventId)}` : "");
