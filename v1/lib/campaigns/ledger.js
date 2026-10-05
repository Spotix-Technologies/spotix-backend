/**
 * v1/lib/campaigns/ledger.js
 *
 * One read path for "what happened to this booker's credits", covering BOTH
 * email and SMS — used by the booker's recent-transactions card, the
 * /campaign/transactions page (infinite scroll) and the admin credits page.
 * The shaping (txn type, direction, per-campaign roll-ups) lives in the
 * get_credit_ledger() Postgres function; see supabase/credits-migration.sql.
 */

import { supabaseAdmin } from "../supabase-admin.js";

const KINDS = new Set(["all", "email", "sms"]);

export function normalizeKind(kind) {
  const k = String(kind || "all").toLowerCase();
  return KINDS.has(k) ? k : null;
}

/**
 * @param {string} organizerId
 * @param {{ kind?: "all"|"email"|"sms", limit?: number, cursor?: string|null }} opts
 *   cursor is the opaque `nextCursor` of the previous page.
 * @returns {Promise<{ transactions: object[], nextCursor: string|null }>}
 */
export async function listCreditLedger(organizerId, { kind = "all", limit = 25, cursor = null } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 25, 1), 100);

  let cursorTs = null;
  let cursorId = null;
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
      cursorTs = parsed.ts;
      cursorId = parsed.id;
    } catch {
      throw new Error("invalid_cursor");
    }
    if (!cursorTs || !cursorId) throw new Error("invalid_cursor");
  }

  // Ask for one extra row to know whether another page exists.
  const { data, error } = await supabaseAdmin.rpc("get_credit_ledger", {
    p_organizer_id: organizerId,
    p_kind: kind,
    p_limit: pageSize + 1,
    p_cursor_ts: cursorTs,
    p_cursor_id: cursorId,
  });
  if (error) throw error;

  const rows = data || [];
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;

  const transactions = page.map((r) => ({
    id: r.entry_id,
    kind: r.kind,                 // "email" | "sms"
    txnType: r.txn_type,          // purchase | used | manual | refund | free
    direction: r.direction,       // added | deducted | reserved
    credits: r.credits,           // positive magnitude
    reference: r.reference || null,
    reason: r.reason || null,
    eventId: r.event_id || null,
    campaignId: r.campaign_id || null,
    createdAt: r.created_at,      // exact string from Postgres (keeps microseconds)
  }));

  // created_at is passed back as the exact string Postgres produced —
  // round-tripping it through a JS Date would drop microseconds and make the
  // keyset comparison skip or repeat rows.
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ ts: last.created_at, id: last.entry_id })).toString("base64url")
    : null;

  return { transactions, nextCursor };
}
