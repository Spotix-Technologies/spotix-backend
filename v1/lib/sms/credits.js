// v1/lib/sms/credits.js
//
// Thin wrappers around the SMS RPC functions in supabase/sms-schema.sql.
// All balance mutation happens inside Postgres (row-locked, atomic) — nothing
// here reads-then-writes a balance.

import { supabaseAdmin } from "../supabase-admin.js";

export class InsufficientSmsCreditsError extends Error {
  constructor(extra = {}) {
    super("insufficient_credits");
    Object.assign(this, extra);
  }
}

function first(data) {
  return Array.isArray(data) ? data[0] : data;
}

export async function getOrInitSmsCredits(organizerId) {
  const { data, error } = await supabaseAdmin.rpc("get_or_init_sms_credits", { p_organizer_id: organizerId });
  if (error) throw error;
  return first(data);
}

export async function grantSmsCredits(organizerId, amount, reference) {
  const { data, error } = await supabaseAdmin.rpc("grant_sms_credits", {
    p_organizer_id: organizerId,
    p_amount: amount,
    p_reference: reference,
  });
  if (error) throw error;
  return first(data);
}

/** Admin-only manual top-up / correction — always ledgered with a reason. */
export async function adminAdjustSmsCredits(organizerId, amount, reason, createdBy) {
  const { data, error } = await supabaseAdmin.rpc("admin_adjust_sms_credits", {
    p_organizer_id: organizerId,
    p_amount: amount,
    p_reason: reason,
    p_created_by: createdBy,
  });
  if (error) throw error;
  return first(data);
}
