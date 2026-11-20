/**
 * v1/lib/edit-history/diff.js
 *
 * Pure helpers: turn a before/after pair of plain objects into the
 * { field: { before, after } } shape stored in event_edit_history.changes,
 * scrub anything that must never be persisted, and build the one-line
 * summary shown in the UI. No I/O in here, so it is trivially testable.
 */

// Never written to history, whatever a caller sends.
const IGNORED_FIELDS = new Set(["updatedAt", "createdAt", "usedCount", "ticketsSold"]);
const SECRET_PATTERN = /(secret|token|password|passcode|apikey|api_key|vaultkey|synckey|signature|authorization)|^(pin|key)$/i;

const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_FIELDS = 40;

export function sanitizeValue(value, depth = 0) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString(); // Firestore Timestamp
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitizeValue(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // System-maintained counters inside nested objects (ticket tiers carry
      // ticketsSold) change on every sale — they are not an edit by a person.
      if (SECRET_PATTERN.test(k) || IGNORED_FIELDS.has(k)) continue;
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Canonical form used ONLY for equality: forms send "5000" where Firestore
 * holds 5000, and "" where it holds null — neither is a real edit.
 */
function canon(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(canon);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canon(value[k])]));
  }
  return value;
}

/** Diff two flat-ish objects over the union of their keys (or `fields` if given). */
export function diffObjects(before = {}, after = {}, fields) {
  const keys = fields?.length ? fields : [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  const changes = {};
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key) || SECRET_PATTERN.test(key)) continue;
    const b = sanitizeValue(before?.[key]);
    const a = sanitizeValue(after?.[key]);
    if (JSON.stringify(canon(b)) !== JSON.stringify(canon(a))) changes[key] = { before: b, after: a };
    if (Object.keys(changes).length >= MAX_FIELDS) break;
  }
  return changes;
}

/** Sanitize a caller-supplied { field: { before, after } } map. */
export function sanitizeChanges(changes = {}) {
  const out = {};
  for (const [field, change] of Object.entries(changes)) {
    if (IGNORED_FIELDS.has(field) || SECRET_PATTERN.test(field)) continue;
    out[field] = { before: sanitizeValue(change?.before), after: sanitizeValue(change?.after) };
    if (Object.keys(out).length >= MAX_FIELDS) break;
  }
  return out;
}

const FIELD_LABELS = {
  eventName: "name", eventDescription: "description", eventDate: "start date", eventEndDate: "end date",
  eventStart: "start time", eventEnd: "end time", eventVenue: "venue", eventType: "event type",
  country: "country", state: "state", isFree: "free/paid", ticketPrices: "ticket prices",
  enableStopDate: "sales stop date toggle", stopDate: "sales stop date", enableColorCode: "colour code toggle",
  colorCode: "colour code", enableMaxSize: "max size toggle", maxSize: "max size",
  eventSlug: "event link", allowAPIAccess: "API access", widgetLength: "widget width", widgetHeight: "widget height",
  widgetColour: "widget colour", allowAgents: "agent activity", agentIncentive: "agent incentive",
  feeBurden: "fee payer", eventImages: "additional images",
};

export function labelField(field) {
  return FIELD_LABELS[field] || field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export function buildSummary(action, changes) {
  const fields = Object.keys(changes);
  if (!fields.length) return action.replaceAll("_", " ");
  const labels = fields.slice(0, 4).map(labelField);
  const more = fields.length > 4 ? ` +${fields.length - 4} more` : "";
  return `Changed ${labels.join(", ")}${more}`;
}
