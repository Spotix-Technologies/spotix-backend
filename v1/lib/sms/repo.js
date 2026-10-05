// v1/lib/sms/repo.js
//
// Bulk SMS campaigns (table `sms_campaign`) + the numbers .txt files in the
// private `sms-campaigns` Supabase Storage bucket.
//
// Create flow (one call from the booker's "Upload" button):
//   1. validate + dedupe every number server-side (never trust the browser)
//   2. cheap pre-check of the booker's SMS credits
//   3. build ONE .txt file, one number per line, and upload it to Storage
//   4. create_sms_campaign RPC — inserts the row (with the file url) AND
//      reserves the credits in a single Postgres transaction
//   5. if step 4 fails, the uploaded file is removed again

import crypto from "node:crypto";
import { supabaseAdmin } from "../supabase-admin.js";
import { validateNumbers, MAX_RECIPIENTS } from "./phone.js";
import { getOrInitSmsCredits, InsufficientSmsCreditsError } from "./credits.js";

export const SMS_CAMPAIGN_TABLE = "sms_campaign";
export const SMS_BUCKET = "sms-campaigns";
export const MAX_SMS_MESSAGE_LENGTH = 480; // keep in sync with spotix-booker/app/lib/sms-phone.ts

export class SmsValidationError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.code = "validation_failed";
    Object.assign(this, extra);
  }
}
export class SmsStateError extends Error {
  constructor(currentStatus) {
    super(`Campaign is already ${currentStatus}`);
    this.code = "invalid_state";
    this.currentStatus = currentStatus;
  }
}
export class SmsNotFoundError extends Error {}

// ─── create ──────────────────────────────────────────────────────────────

export async function createSmsCampaign({
  organizerId, organizerEmail, organizerUsername, eventId, eventName, name, message, numbers: rawNumbers,
}) {
  const cleanName = String(name ?? "").trim();
  const cleanMessage = String(message ?? "").trim();
  if (!cleanName) throw new SmsValidationError("Give the campaign a name");
  if (!cleanMessage) throw new SmsValidationError("Write the message you want to send");
  if (cleanMessage.length > MAX_SMS_MESSAGE_LENGTH) {
    throw new SmsValidationError(`The message can be at most ${MAX_SMS_MESSAGE_LENGTH} characters`);
  }

  const { numbers, invalid } = validateNumbers(rawNumbers);
  if (invalid.length) {
    throw new SmsValidationError(`${invalid.length} number(s) are invalid`, { invalid: invalid.slice(0, 50) });
  }
  if (!numbers.length) throw new SmsValidationError("Add at least one phone number");
  if (numbers.length > MAX_RECIPIENTS) {
    throw new SmsValidationError(`A single bulk SMS can have at most ${MAX_RECIPIENTS.toLocaleString("en-NG")} numbers`);
  }

  // Fast-fail before uploading anything. The RPC re-checks atomically.
  const credits = await getOrInitSmsCredits(organizerId);
  if ((credits?.available ?? 0) < numbers.length) {
    throw new InsufficientSmsCreditsError({ available: credits?.available ?? 0, required: numbers.length });
  }

  const path = `${organizerId}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`;
  const file = Buffer.from(numbers.join("\n"), "utf-8");

  const { error: uploadError } = await supabaseAdmin.storage
    .from(SMS_BUCKET)
    .upload(path, file, { contentType: "text/plain", upsert: false });
  if (uploadError) throw new Error(`Failed to upload numbers file: ${uploadError.message}`);

  const url = supabaseAdmin.storage.from(SMS_BUCKET).getPublicUrl(path).data.publicUrl;

  const { data, error } = await supabaseAdmin.rpc("create_sms_campaign", {
    p_organizer_id: organizerId,
    p_organizer_email: organizerEmail || null,
    p_organizer_username: organizerUsername || null,
    p_event_id: eventId,
    p_event_name: eventName,
    p_name: cleanName,
    p_message: cleanMessage,
    p_recipient_count: numbers.length,
    p_file_path: path,
    p_file_url: url,
    // Saved as rows too (same transaction as the campaign + reservation) so
    // admins can look a phone number up. The .txt file stays the delivery copy.
    p_numbers: numbers,
  });

  if (error) {
    await supabaseAdmin.storage.from(SMS_BUCKET).remove([path]).catch(() => {});
    if (String(error.message).includes("insufficient_credits")) {
      const fresh = await getOrInitSmsCredits(organizerId).catch(() => null);
      throw new InsufficientSmsCreditsError({ available: fresh?.available ?? 0, required: numbers.length });
    }
    throw error;
  }
  return Array.isArray(data) ? data[0] : data;
}

// ─── reads ───────────────────────────────────────────────────────────────

export async function listSmsCampaignsForOrganizer(organizerId, limit = 50) {
  const { data, error } = await supabaseAdmin
    .from(SMS_CAMPAIGN_TABLE)
    .select("*")
    .eq("organizer_id", organizerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function getSmsCampaign(id) {
  const { data, error } = await supabaseAdmin.from(SMS_CAMPAIGN_TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * The append-only ledger for one campaign, oldest first (see
 * sms_campaign_events in supabase/campaign-timeline-migration.sql).
 * This is the booker-facing shape: the admin's name is deliberately NOT
 * included — bookers see what happened and when, not who clicked the button.
 */
export async function getSmsCampaignTimeline(campaignId) {
  const { data, error } = await supabaseAdmin
    .from("sms_campaign_events")
    .select("id, event_type, note, created_at")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return (data || []).map((e) => ({
    id: e.id,
    type: e.event_type,          // created | approved | rejected | delivered
    at: e.created_at,
    note: e.note || null,        // rejection reason
  }));
}

export async function listSmsCampaignsAdmin({ status, limit = 100 } = {}) {
  let query = supabaseAdmin.from(SMS_CAMPAIGN_TABLE).select("*").order("created_at", { ascending: false }).limit(limit);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/** The numbers back out of the stored .txt file (used by "edit & resend"). */
export async function getSmsCampaignNumbers(campaign) {
  const { data, error } = await supabaseAdmin.storage.from(SMS_BUCKET).download(campaign.numbers_file_path);
  if (error) throw new Error(`Failed to read numbers file: ${error.message}`);
  const text = await data.text();
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Short-lived download link for the admin dashboard (bucket is private). */
export async function getSmsNumbersSignedUrl(campaign, expiresInSeconds = 3600) {
  const { data, error } = await supabaseAdmin.storage
    .from(SMS_BUCKET)
    .createSignedUrl(campaign.numbers_file_path, expiresInSeconds, { download: `${campaign.id}.txt` });
  if (error) return null;
  return data?.signedUrl || null;
}

// ─── admin decisions (atomic, via RPC) ───────────────────────────────────

async function callDecisionRpc(fn, args) {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) {
    const msg = String(error.message || "");
    if (msg.includes("campaign_not_found")) throw new SmsNotFoundError();
    const m = msg.match(/invalid_state:(\w+)/);
    if (m) throw new SmsStateError(m[1]);
    throw error;
  }
  return Array.isArray(data) ? data[0] : data;
}

export const approveSmsCampaign = (id, admin) =>
  callDecisionRpc("approve_sms_campaign", { p_campaign_id: id, p_admin: admin });

export const rejectSmsCampaign = (id, reason, admin) =>
  callDecisionRpc("reject_sms_campaign", { p_campaign_id: id, p_reason: reason, p_admin: admin });

export const deliverSmsCampaign = (id, admin) =>
  callDecisionRpc("deliver_sms_campaign", { p_campaign_id: id, p_admin: admin });

// ─── admin: phone number lookup ──────────────────────────────────────────

export const SMS_LOOKUP_RESULT_CAP = 15; // keep in step with LOOKUP_RESULT_CAP in campaigns/repo.js

/**
 * The SMS_LOOKUP_RESULT_CAP most recent bulk SMS campaigns a phone number was
 * part of (needs the 11-digit local form — normalise first), plus an exact
 * all-time count. Mirrors getRecipientHistoryByEmail for email.
 */
export async function getSmsHistoryByPhone(phone) {
  const { data, error } = await supabaseAdmin
    .from("sms_campaign_recipients")
    .select("id, phone, created_at, sms_campaign(id, name, event_name_snapshot, organizer_id, organizer_email, organizer_username, status, recipient_count, message_text, created_at)")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(SMS_LOOKUP_RESULT_CAP);
  if (error) throw error;

  const { count, error: countError } = await supabaseAdmin
    .from("sms_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone);
  if (countError) throw countError;

  return { history: data || [], totalCampaigns: count ?? (data || []).length };
}
