/**
 * v1/lib/edit-history/repo.js
 *
 * Reads/writes public.event_edit_history (supabase/event-edit-history-schema.sql).
 * Callers (spotix-booker, spotix-admin) only ever reach this through the
 * internal /v1/edit-history routes — they never hold the service-role key.
 */

import { supabaseAdmin } from "../supabase-admin.js";
import { adminDb } from "../../utils/firebase.js";
import { buildSummary, diffObjects, sanitizeChanges } from "./diff.js";

const TABLE = "event_edit_history";
const ACTOR_TYPES = new Set(["organizer", "event_teammate", "Spotix"]);
const SOURCES = new Set(["booker", "admin", "system"]);

// Small in-memory cache so a burst of edits by one person (e.g. toggling
// several discounts) costs one Firestore read for the display name, not N.
const nameCache = new Map(); // uid -> { name, at }
const NAME_TTL_MS = 10 * 60 * 1000;

async function resolveActorName(uid, fallback) {
  if (fallback) return String(fallback).slice(0, 120);
  const hit = nameCache.get(uid);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;
  try {
    const snap = await adminDb.collection("users").doc(uid).get();
    const u = snap.exists ? snap.data() : {};
    const name = u.username || u.bookerName || u.fullName || null;
    nameCache.set(uid, { name, at: Date.now() });
    return name;
  } catch {
    return null;
  }
}

export class EditHistoryValidationError extends Error {}

/**
 * Validates + normalises a payload and inserts one row.
 *
 * Body shape:
 *   { eventId, organizerId, action, actor: { uid, type, role, name? },
 *     reason?, source?,
 *     before?/after?  (plain objects — diffed here, only changed fields kept)
 *     fields?         (optional allow-list of keys to diff)
 *     changes?        ({ field: { before, after } } — used as-is after sanitising) }
 *
 * Returns the inserted row, or null when nothing actually changed (so a
 * no-op "Save" doesn't pollute the timeline).
 */
export async function recordEditHistory(body) {
  const { eventId, organizerId, action, actor, reason, source, before, after, fields, changes } = body || {};

  if (!eventId || typeof eventId !== "string") throw new EditHistoryValidationError("eventId is required");
  if (!organizerId || typeof organizerId !== "string") throw new EditHistoryValidationError("organizerId is required");
  if (!action || typeof action !== "string") throw new EditHistoryValidationError("action is required");
  if (!actor?.uid || typeof actor.uid !== "string") throw new EditHistoryValidationError("actor.uid is required");

  const finalChanges = changes && typeof changes === "object"
    ? sanitizeChanges(changes)
    : diffObjects(before || {}, after || {}, Array.isArray(fields) ? fields : undefined);

  if (!Object.keys(finalChanges).length) return null;

  const actorType = ACTOR_TYPES.has(actor.type) ? actor.type : "organizer";
  const actorName = await resolveActorName(actor.uid, actor.name);

  const row = {
    event_id: eventId,
    organizer_id: organizerId,
    action: action.slice(0, 64),
    summary: buildSummary(action, finalChanges).slice(0, 240),
    changes: finalChanges,
    reason: typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null,
    actor_uid: actor.uid,
    actor_type: actorType,
    actor_role: actor.role ? String(actor.role).slice(0, 80) : null,
    actor_name: actorName,
    source: SOURCES.has(source) ? source : "booker",
  };

  const { data, error } = await supabaseAdmin.from(TABLE).insert(row).select().single();
  if (error) throw error;
  return data;
}

/** Newest-first page. `before` is an ISO timestamp cursor (created_at of the last row seen). */
export async function listEditHistory({ eventId, limit = 25, before }) {
  const pageSize = Math.min(Math.max(Number(limit) || 25, 1), 100);
  let query = supabaseAdmin
    .from(TABLE)
    .select("id,event_id,action,summary,changes,reason,actor_uid,actor_type,actor_role,actor_name,source,created_at")
    .eq("event_id", eventId)
    .order("created_at", { ascending: false })
    .limit(pageSize + 1); // one extra row tells us whether another page exists

  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) throw error;

  const hasMore = data.length > pageSize;
  const rows = hasMore ? data.slice(0, pageSize) : data;
  return {
    entries: rows.map((r) => ({
      id: r.id,
      action: r.action,
      summary: r.summary,
      actor: { uid: r.actor_uid, type: r.actor_type, role: r.actor_role, name: r.actor_name },
      changes: r.changes || {},
      reason: r.reason || undefined,
      source: r.source,
      createdAt: r.created_at,
    })),
    nextCursor: hasMore ? rows[rows.length - 1].created_at : null,
  };
}
