/**
 * v1/lib/campaigns/credits.js
 *
 * Thin wrapper around the Postgres RPC functions in
 * supabase/credits-migration.sql. Email credits belong to the BOOKER
 * (organizer_id), exactly like SMS credits — one balance that every one of
 * their events draws from. All mutation happens inside those functions
 * (atomic, row-locked); nothing here reads-then-writes a balance, to avoid the
 * overselling race (spec §14).
 *
 * eventId is still passed to reserve / consume / refund, but only so the
 * ledger row records which event the campaign was for — it plays no part in
 * the accounting.
 */

import { supabaseAdmin } from "../supabase-admin.js";

export class InsufficientCreditsError extends Error {
  constructor() {
    super("insufficient_credits");
  }
}

function first(data) {
  return Array.isArray(data) ? data[0] : data;
}

/** Ensures the booker has an email-credit row, granting the one-time 200 free
 *  credits exactly once per account. Safe to call on every page load. */
export async function getOrInitEmailCredits(organizerId) {
  const { data, error } = await supabaseAdmin.rpc("init_email_credits", {
    p_organizer_id: organizerId,
  });
  if (error) throw error;
  return first(data);
}

/** Read-only balance for admin views. Unlike getOrInitEmailCredits this never
 *  creates a row or grants the free credits — an admin looking someone up must
 *  not change their balance. */
export async function peekEmailCredits(organizerId) {
  const { data, error } = await supabaseAdmin
    .from("email_credits")
    .select("*")
    .eq("organizer_id", organizerId)
    .maybeSingle();
  if (error) throw error;
  return data || { organizer_id: organizerId, available: 0, reserved: 0, consumed: 0, free_credit_granted: false };
}

export async function reserveCampaignCredits(organizerId, campaignId, eventId, amount, createdBy) {
  const { data, error } = await supabaseAdmin.rpc("reserve_email_credits", {
    p_organizer_id: organizerId,
    p_campaign_id: campaignId,
    p_event_id: eventId || null,
    p_amount: amount,
    p_created_by: createdBy,
  });
  if (error) {
    if (String(error.message).includes("insufficient_credits")) {
      throw new InsufficientCreditsError();
    }
    throw error;
  }
  return first(data);
}

export async function consumeRecipientCredit(organizerId, campaignId, eventId) {
  const { data, error } = await supabaseAdmin.rpc("consume_email_credit", {
    p_organizer_id: organizerId,
    p_campaign_id: campaignId,
    p_event_id: eventId || null,
  });
  if (error) throw error;
  return first(data);
}

export async function refundRecipientCredit(organizerId, campaignId, eventId) {
  const { data, error } = await supabaseAdmin.rpc("refund_email_credit", {
    p_organizer_id: organizerId,
    p_campaign_id: campaignId,
    p_event_id: eventId || null,
  });
  if (error) throw error;
  return first(data);
}

/** Admin-only manual top-up / correction — always ledgered with a reason. */
export async function adminAdjustEmailCredits(organizerId, amount, reason, createdBy) {
  const { data, error } = await supabaseAdmin.rpc("admin_adjust_email_credits", {
    p_organizer_id: organizerId,
    p_amount: amount,
    p_reason: reason,
    p_created_by: createdBy,
  });
  if (error) throw error;
  return first(data);
}

/** Grants credits from a verified Paystack purchase (spec §16–17). Idempotent
 *  on `reference`. statisticsEnabled is always true now — analytics are part of
 *  every purchase — the parameter is kept because the column still exists. */
export async function grantPurchasedCredits(organizerId, amount, reference, statisticsEnabled = true) {
  const { data, error } = await supabaseAdmin.rpc("grant_email_credits_purchase", {
    p_organizer_id: organizerId,
    p_amount: amount,
    p_reference: reference,
    p_statistics_enabled: !!statisticsEnabled,
  });
  if (error) throw error;
  return first(data);
}
