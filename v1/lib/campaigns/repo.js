/**
 * v1/lib/campaigns/repo.js
 *
 * Plain CRUD/query helpers over the campaigns / campaign_recipients
 * tables (supabase/campaign-schema.sql). No business logic here beyond
 * email normalization/dedup (spec §46) — credit accounting lives in
 * credits.js, delivery lives in Phase 2's provider modules.
 */

import { supabaseAdmin } from "../supabase-admin.js";
import { sendCampaignSentEmail } from "./notifications.js";
import { generateSenderEmail } from "./sender.js";

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/** Dedupes a raw {name, email}[] list by normalized email, dropping
 *  anything without a plausible email address (spec §24/§46). */
export function dedupeRecipients(rawList) {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const seen = new Map();
  for (const entry of rawList || []) {
    const email = normalizeEmail(entry?.email);
    if (!email || !EMAIL_RE.test(email)) continue;
    if (!seen.has(email)) {
      seen.set(email, { email, name: entry?.name ? String(entry.name).trim() : null });
    }
  }
  return Array.from(seen.values());
}

export async function createCampaign({
  eventId, organizerId, eventNameSnapshot, eventSlugSnapshot, name, statisticsEnabled,
  templateId, messageText, brandColor, replyToAddress, ctaText,
  eventVenueSnapshot, eventDateSnapshot, eventStartSnapshot, eventEndSnapshot,
  ticketPricesSnapshot, isFreeSnapshot, organizerEmail, organizerName,
}) {
  const senderEmail = generateSenderEmail();
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .insert({
      event_id: eventId,
      organizer_id: organizerId,
      event_name_snapshot: eventNameSnapshot,
      event_slug_snapshot: eventSlugSnapshot,
      name,
      subject: name, // campaign name IS the email subject, spec §28
      sender_email: senderEmail,
      sender_name: eventNameSnapshot,
      reply_to_address: replyToAddress || null,
      statistics_enabled: !!statisticsEnabled,
      template_id: templateId || "classic",
      message_text: messageText || null,
      brand_color: brandColor || "#6D28D9",
      cta_text: ctaText || "View Event",
      // Who to email about this campaign (sent / flagged). Resolved
      // server-side by spotix-booker from the organizer's user doc.
      organizer_email: organizerEmail || null,
      organizer_name: organizerName || null,
      // Snapshotted at creation time purely for the moderation prompt
      // (v1/lib/campaigns/moderation) to check the organizer's message
      // against the real event facts — never re-read live, same spirit
      // as event_name_snapshot/event_slug_snapshot above.
      event_venue_snapshot: eventVenueSnapshot || null,
      event_date_snapshot: eventDateSnapshot || null,
      event_start_snapshot: eventStartSnapshot || null,
      event_end_snapshot: eventEndSnapshot || null,
      ticket_prices_snapshot: ticketPricesSnapshot || null,
      is_free_snapshot: !!isFreeSnapshot,
      status: "draft",
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getCampaign(campaignId) {
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listCampaignsForEvent(eventId, limit = 25) {
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .select("*")
    .eq("event_id", eventId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/** Admin/IT event lookup (spec §38) — no organizer scoping, unlike the
 *  organizer-facing listCampaignsForEvent above (same query, but this
 *  name makes the missing ownership check intentional and obvious at
 *  the call site rather than an accident). */
export const listCampaignsForEventAdmin = listCampaignsForEvent;

export async function insertRecipients(campaignId, recipients) {
  if (!recipients.length) return [];
  const rows = recipients.map((r) => ({
    campaign_id: campaignId,
    email: r.email,
    name: r.name,
    status: "pending",
  }));
  // upsert on (campaign_id, email) so a retry of this call can't double-insert
  const { data, error } = await supabaseAdmin
    .from("campaign_recipients")
    .upsert(rows, { onConflict: "campaign_id,email", ignoreDuplicates: true })
    .select();
  if (error) throw error;
  return data || [];
}

export async function updateCampaign(campaignId, patch) {
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Upserts into the reusable contacts table (spec §9) so unsubscribe
 *  status is tracked per organizer+email, not per campaign. */
export async function upsertContacts(organizerId, recipients, source) {
  if (!recipients.length) return;
  const rows = recipients.map((r) => ({
    organizer_id: organizerId, email: r.email, name: r.name, source,
  }));
  const { error } = await supabaseAdmin
    .from("contacts")
    .upsert(rows, { onConflict: "organizer_id,email", ignoreDuplicates: true });
  if (error) throw error;
}

/** Returns the subset of `emails` this organizer's contacts have marked
 *  unsubscribed (spec §55) — checked before every send, not just once
 *  at campaign creation, since someone can unsubscribe mid-campaign. */
export async function getUnsubscribedEmails(organizerId, emails) {
  if (!emails.length) return new Set();
  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("email")
    .eq("organizer_id", organizerId)
    .eq("unsubscribed", true)
    .in("email", emails);
  if (error) throw error;
  return new Set((data || []).map((r) => r.email));
}

export async function setUnsubscribed(organizerId, email, unsubscribed) {
  const { error } = await supabaseAdmin
    .from("contacts")
    .update({ unsubscribed, updated_at: new Date().toISOString() })
    .eq("organizer_id", organizerId)
    .eq("email", normalizeEmail(email));
  if (error) throw error;
}

/** Batch of recipients still due to be sent: never-attempted, or a
 *  transient failure whose retry window has arrived (spec §33). */
export async function getSendableRecipients(campaignId, limit) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("campaign_recipients")
    .select("*")
    .eq("campaign_id", campaignId)
    .or(`status.eq.pending,and(status.eq.failed,next_retry_at.lte.${nowIso})`)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function updateRecipient(id, patch) {
  const { error } = await supabaseAdmin
    .from("campaign_recipients")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Same as updateRecipient, but the write is conditioned on the row's
 *  *current* status being one of `allowedStatuses` — a single atomic
 *  `UPDATE ... WHERE status IN (...)` rather than a read-then-write, so
 *  it's race-safe if two webhook events for the same recipient are
 *  processed concurrently. Returns the updated row(s); an empty array
 *  means the row's status had already moved past what the caller
 *  expected, and nothing was changed. */
export async function updateRecipientIfStatusIn(id, patch, allowedStatuses) {
  const { data, error } = await supabaseAdmin
    .from("campaign_recipients")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", allowedStatuses)
    .select();
  if (error) throw error;
  return data || [];
}

/** Recipients this campaign can still retry — permanently-invalid
 *  addresses (SES MessageRejected / Resend "invalid") are excluded so a
 *  retry never wastes a batch re-attempting an address that will never
 *  work (spec §33/§39). */
export async function getRetryableRecipients(campaignId, limit = 500) {
  const { data, error } = await supabaseAdmin
    .from("campaign_recipients")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("status", "failed")
    .limit(limit);
  if (error) throw error;
  const HARD_FAIL = /invalid|MessageRejected|domain is not verified/i;
  return (data || []).filter((r) => !HARD_FAIL.test(r.last_error || ""));
}

/** getCampaignRecipients — default 200 (detail-page table), or the full
 *  audience up to CLONE_RECIPIENTS_LIMIT when `limit` is passed as
 *  "all" (used by GET /campaigns/:id/recipients?all=1, which backs the
 *  "clone this campaign" flow — the whole point there is carrying over
 *  every recipient, not just the first page). Still capped rather than
 *  truly unbounded, so a pathological audience can't turn one request
 *  into an unbounded Postgres scan. */
const CLONE_RECIPIENTS_LIMIT = 20000;

export async function getCampaignRecipients(campaignId, limit = 200) {
  const { data, error } = await supabaseAdmin
    .from("campaign_recipients")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true })
    .limit(limit === "all" ? CLONE_RECIPIENTS_LIMIT : limit);
  if (error) throw error;
  return data || [];
}

/** Admin individual-email inspection (spec §40) — every
 *  campaign_recipients row for this address, newest first, with just
 *  enough campaign context to identify each one without a second
 *  round trip per row. */
export const LOOKUP_RESULT_CAP = 15;

/** Admin email lookup: the LOOKUP_RESULT_CAP most recent campaigns this
 *  address was part of, plus all-time totals (computed separately so the cap
 *  only limits what's listed, not what's counted). */
export async function getRecipientHistoryByEmail(email) {
  const normalized = normalizeEmail(email);

  const { data, error } = await supabaseAdmin
    .from("campaign_recipients")
    .select("*, campaigns(id, name, event_id, event_name_snapshot, organizer_id, delivery_provider)")
    .eq("email", normalized)
    .order("created_at", { ascending: false })
    .limit(LOOKUP_RESULT_CAP);
  if (error) throw error;

  const { data: statuses, error: aggError } = await supabaseAdmin
    .from("campaign_recipients")
    .select("status, created_at")
    .eq("email", normalized)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (aggError) throw aggError;

  return { history: data || [], allStatuses: statuses || [] };
}

/** Global analytics totals (spec §41), optionally windowed by
 *  created_at. Summed in JS rather than a SQL aggregate view — simplest
 *  thing that works at the campaign-table's current scale; worth a real
 *  materialized view if the campaigns table gets huge. */
export async function getGlobalCampaignTotals({ since, until } = {}) {
  let query = supabaseAdmin.from("campaigns").select(
    "total_recipients,sent_count,delivered_count,bounced_count,opened_count,clicked_count,failed_count"
  );
  if (since) query = query.gte("created_at", since);
  if (until) query = query.lte("created_at", until);
  const { data, error } = await query;
  if (error) throw error;

  const totals = { totalCampaigns: 0, totalRecipients: 0, totalSent: 0, totalDelivered: 0, totalBounced: 0, totalOpened: 0, totalClicked: 0, totalFailed: 0 };
  for (const c of data || []) {
    totals.totalCampaigns += 1;
    totals.totalRecipients += c.total_recipients || 0;
    totals.totalSent += c.sent_count || 0;
    totals.totalDelivered += c.delivered_count || 0;
    totals.totalBounced += c.bounced_count || 0;
    totals.totalOpened += c.opened_count || 0;
    totals.totalClicked += c.clicked_count || 0;
    totals.totalFailed += c.failed_count || 0;
  }
  return totals;
}

export async function findRecipientByProviderMessageId(campaignId, providerMessageId) {
  const { data, error } = await supabaseAdmin
    .from("campaign_recipients")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertEmailEvent({ campaignId, campaignRecipientId, provider, providerEventId, eventType, payload }) {
  // Unique index on (provider, provider_event_id) makes this the
  // idempotency guard (spec §4/§34) — a duplicate insert throws 23505,
  // which the caller treats as "already processed, skip."
  const { error } = await supabaseAdmin
    .from("email_events")
    .insert({
      campaign_id: campaignId,
      campaign_recipient_id: campaignRecipientId,
      provider,
      provider_event_id: providerEventId || null,
      event_type: eventType,
      // Which link a "clicked" event was for (SES: click.link, Resend:
      // click.link — both webhook routes lift this into payload.linkUrl
      // before calling here). Pulled into its own column so "what got
      // clicked" is a plain select, not a jsonb dig through payload.
      link_url: payload?.linkUrl || null,
      payload: payload || null,
    });
  if (error) {
    if (error.code === "23505") return { duplicate: true };
    throw error;
  }
  return { duplicate: false };
}

/** The recipient-level "ledger" (spec ask: an immutable, per-event
 *  timeline for a single recipient on a single campaign) — the
 *  campaign_recipients row for its current state/timestamps, plus every
 *  email_events row recorded for it, oldest first. email_events is
 *  already append-only (insertEmailEvent above never updates or
 *  deletes), so this is just reading that ledger back, not computing
 *  anything new. Returns null if the recipient doesn't belong to this
 *  campaign (or doesn't exist) — the caller treats that as 404. */
export async function getRecipientLedger(campaignId, campaignRecipientId) {
  const { data: recipient, error: recipientError } = await supabaseAdmin
    .from("campaign_recipients")
    .select("*")
    .eq("id", campaignRecipientId)
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (recipientError) throw recipientError;
  if (!recipient) return null;

  const { data: events, error: eventsError } = await supabaseAdmin
    .from("email_events")
    .select("event_type,event_timestamp,provider,link_url,created_at")
    .eq("campaign_recipient_id", campaignRecipientId)
    .order("event_timestamp", { ascending: true });
  if (eventsError) throw eventsError;

  return { recipient, events: events || [] };
}

/** Recomputes campaign aggregate counters from campaign_recipients — the
 *  single source of truth avoids drift between per-recipient updates and
 *  the counters shown on the dashboard (spec §56). Called after each
 *  processing batch and each webhook event, not on every dashboard load. */
export async function recomputeCampaignAggregates(campaignId) {
  const { data, error } = await supabaseAdmin
    .from("campaign_recipients")
    .select("status,next_retry_at")
    .eq("campaign_id", campaignId);
  if (error) throw error;

  const counts = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0, complained: 0 };
  let pending = 0;
  for (const r of data || []) {
    const awaitingRetry = r.status === "failed" && r.next_retry_at; // scheduled retry, not done yet
    if (r.status === "pending" || r.status === "sending" || awaitingRetry) {
      pending += 1;
      continue;
    }
    if (r.status === "bounced" || r.status === "failed" || r.status === "complained") {
      counts[r.status] += 1;
      continue;
    }
    // Funnel counts are cumulative — reaching "clicked" means a
    // recipient was necessarily "sent", "delivered", AND "opened"
    // first, and should still count at every one of those earlier
    // stages, not just their current (furthest) one. Before this fix,
    // only "sent" got that treatment — delivered_count/opened_count
    // only counted recipients CURRENTLY sitting at exactly that status,
    // so advancing past a stage made its count drop, i.e. clicking an
    // email could make delivered_count go DOWN.
    if (["sent", "delivered", "opened", "clicked"].includes(r.status)) counts.sent += 1;
    if (["delivered", "opened", "clicked"].includes(r.status)) counts.delivered += 1;
    if (["opened", "clicked"].includes(r.status)) counts.opened += 1;
    if (r.status === "clicked") counts.clicked += 1;
  }

  const campaign = await getCampaign(campaignId);
  const isDone = pending === 0 && campaign && !["draft", "pending_review", "flagged", "waiting_for_provider"].includes(campaign.status);
  const hadErrors = counts.bounced + counts.failed + counts.complained > 0;

  const updated = await updateCampaign(campaignId, {
    sent_count: counts.sent,
    delivered_count: counts.delivered,
    opened_count: counts.opened,
    clicked_count: counts.clicked,
    bounced_count: counts.bounced,
    failed_count: counts.failed,
    complained_count: counts.complained,
    queued_count: pending,
    ...(isDone
      ? { status: hadErrors ? "completed_with_errors" : "completed", completed_at: new Date().toISOString() }
      : {}),
  });

  // Tell the organizer once, when the campaign first finishes. The
  // claim is an atomic "set if still null" so concurrent recomputes
  // (worker + webhooks) can't send the email twice.
  if (isDone && !campaign.success_email_sent_at) {
    const { data: claimed } = await supabaseAdmin
      .from("campaigns")
      .update({ success_email_sent_at: new Date().toISOString() })
      .eq("id", campaignId)
      .is("success_email_sent_at", null)
      .select("id");
    if (claimed?.length) await sendCampaignSentEmail(updated);
  }

  return updated;
}
