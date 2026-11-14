// v1/lib/affiliate/event-time.js
//
// Works out the exact moment an event ends so affiliate withdrawals can be
// gated to "24 hours AFTER the event has ended". Events store date and time
// as separate strings (eventEndDate + eventEnd), interpreted in WAT
// (Africa/Lagos, UTC+1, no DST).

export const AFFILIATE_LOCK_MS = 24 * 60 * 60 * 1000;
const WAT_OFFSET_MS = 60 * 60 * 1000;

function parseDateParts(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") value = value.toDate();
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
  }
  const str = String(value);
  const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) return null;
  return { y: parsed.getFullYear(), m: parsed.getMonth() + 1, d: parsed.getDate() };
}

function parseTimeParts(value) {
  if (!value) return { h: 23, min: 59 }; // no time given -> end of that day
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?/);
  if (!match) return { h: 23, min: 59 };
  let h = +match[1];
  const min = +match[2];
  const mer = match[3]?.toLowerCase();
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  return { h, min };
}

/** @returns {number|null} epoch ms of the event's end, or null if unparsable */
export function getEventEndMs(event) {
  const date = parseDateParts(event?.eventEndDate || event?.eventDate);
  if (!date) return null;
  const { h, min } = parseTimeParts(event?.eventEnd);
  return Date.UTC(date.y, date.m - 1, date.d, h, min) - WAT_OFFSET_MS;
}

export function getWithdrawableAtMs(event) {
  const end = getEventEndMs(event);
  return end === null ? null : end + AFFILIATE_LOCK_MS;
}
