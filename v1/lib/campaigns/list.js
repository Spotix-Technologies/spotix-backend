/**
 * v1/lib/campaigns/list.js
 *
 * One newest-first list of a booker's email AND SMS campaigns, for
 * /campaign/list (infinite scroll). The two kinds live in different tables;
 * the union + keyset pagination is done by list_campaigns() in
 * supabase/campaign-timeline-migration.sql.
 */

import { supabaseAdmin } from "../supabase-admin.js";

export { normalizeKind } from "./ledger.js";

/**
 * @param {string} organizerId
 * @param {{ kind?: "all"|"email"|"sms", limit?: number, cursor?: string|null }} opts
 * @returns {Promise<{ campaigns: object[], nextCursor: string|null }>}
 */
export async function listAllCampaigns(organizerId, { kind = "all", limit = 15, cursor = null } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 15, 1), 100);

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

  // One extra row tells us whether another page exists.
  const { data, error } = await supabaseAdmin.rpc("list_campaigns", {
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

  const campaigns = page.map((r) => ({
    id: r.id,
    type: r.type,               // "email" | "sms"
    name: r.name,
    status: r.status,
    eventId: r.event_id,
    eventName: r.event_name,
    recipients: r.recipients,
    createdAt: r.created_at,    // exact Postgres string (keeps microseconds for the cursor)
  }));

  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ ts: last.created_at, id: last.id })).toString("base64url")
    : null;

  return { campaigns, nextCursor };
}
