/**
 * v1/lib/campaigns/worker.js
 *
 * Core processing cycle, triggered by GET /v1/cron/process-campaigns
 * (external scheduler, same pattern as v1/routes/cron/forecast.js — no
 * in-process cron library needed). Each run:
 *   1. Picks up campaigns waiting on a provider and, if one is now
 *      active, moves them into "processing" (spec §31).
 *   2. For campaigns in "processing", sends one batch of pending/
 *      retry-eligible recipients (spec §32).
 *   3. Recomputes aggregates and flips the campaign to completed /
 *      completed_with_errors once nothing is left pending.
 *
 * Designed to survive a restart mid-run: every recipient's state is
 * persisted before moving to the next, so re-running the cycle after a
 * crash just picks up where it left off (spec §52).
 */

import { supabaseAdmin } from "../supabase-admin.js";
import { resolveDeliveryProvider } from "./config.js";
import { refundRecipientCredit } from "./credits.js";
import {
  getCampaign, updateCampaign, getSendableRecipients, updateRecipient, updateRecipientIfStatusIn,
  recomputeCampaignAggregates, getUnsubscribedEmails, normalizeEmail,
} from "./repo.js";
import { sendViaResend } from "./delivery/resend-provider.js";
import { sendViaSES } from "./delivery/ses-provider.js";
import { runPendingReviews } from "./review.js";

const BATCH_SIZE = 25; // conservative per-cycle batch — spec §32, never load 50k into memory
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 240]; // index = attempt_count - 1

// On-demand (booker-triggered) runs keep draining a campaign batch after
// batch instead of waiting for the next scheduled cycle. Capped so one huge
// campaign can't hold the process forever — whatever is left is picked up by
// the scheduled cycle exactly as before.
const DRAIN_MAX_MS = 4 * 60_000;
const DRAIN_MAX_BATCHES = 400;

// Campaigns currently being processed by THIS process. The scheduled cycle and
// any number of on-demand runs can overlap; this makes them skip a campaign
// that's already in flight. (Across multiple instances, the atomic
// per-recipient claim in processCampaign() is what prevents double sends.)
const inFlight = new Set();

function nextRetryDelayMinutes(attemptCount) {
  return RETRY_BACKOFF_MINUTES[Math.min(attemptCount - 1, RETRY_BACKOFF_MINUTES.length - 1)];
}

async function sendOne(provider, campaign, recipient) {
  if (provider === "ses") return sendViaSES(campaign, recipient);
  return sendViaResend(campaign, recipient);
}

async function processCampaign(campaign, provider) {
  if (campaign.delivery_provider !== provider || campaign.status === "waiting_for_provider") {
    await updateCampaign(campaign.id, { delivery_provider: provider, status: "processing" });
  }

  const recipients = await getSendableRecipients(campaign.id, BATCH_SIZE);
  if (!recipients.length) {
    await recomputeCampaignAggregates(campaign.id);
    return { processed: 0 };
  }

  const unsubscribed = await getUnsubscribedEmails(campaign.organizer_id, recipients.map((r) => normalizeEmail(r.email)));

  for (const recipient of recipients) {
    if (unsubscribed.has(recipient.email)) {
      await updateRecipient(recipient.id, {
        status: "failed", last_error: "unsubscribed", failed_at: new Date().toISOString(),
      });
      await refundRecipientCredit(campaign.organizer_id, campaign.id, campaign.event_id);
      continue;
    }

    // Atomic claim: only one worker can move this recipient to "sending".
    // If another run (cron overlapping an on-demand run, or a second
    // instance) got there first, skip — never send the same email twice.
    const claimed = await updateRecipientIfStatusIn(
      recipient.id,
      { status: "sending", last_attempt_at: new Date().toISOString() },
      ["pending", "failed"],
    );
    if (!claimed.length) continue;

    try {
      const { providerMessageId } = await sendOne(provider, campaign, recipient);
      await updateRecipient(recipient.id, {
        status: "sent",
        provider_message_id: providerMessageId,
        sent_at: new Date().toISOString(),
        attempt_count: recipient.attempt_count + 1,
      });
      // "sent" isn't "delivered" yet — credit consumption happens on the
      // provider's delivery confirmation (webhook), per spec §14. If the
      // provider never confirms, the recipient just stays reserved until
      // an admin/retry resolves it — never silently lost.
    } catch (err) {
      const attemptCount = recipient.attempt_count + 1;
      if (err.transient && attemptCount < MAX_ATTEMPTS) {
        const retryAt = new Date(Date.now() + nextRetryDelayMinutes(attemptCount) * 60_000).toISOString();
        await updateRecipient(recipient.id, {
          status: "failed", attempt_count: attemptCount, last_error: String(err.message).slice(0, 500),
          next_retry_at: retryAt,
        });
      } else {
        // Permanent, or exhausted retries — credit becomes reusable.
        await updateRecipient(recipient.id, {
          status: "failed", attempt_count: attemptCount, last_error: String(err.message).slice(0, 500),
          failed_at: new Date().toISOString(), next_retry_at: null,
        });
        await refundRecipientCredit(campaign.organizer_id, campaign.id, campaign.event_id);
      }
    }
  }

  await recomputeCampaignAggregates(campaign.id);
  return { processed: recipients.length };
}

export async function runCampaignProcessingCycle() {
  const provider = resolveDeliveryProvider();
  const results = { provider, campaignsTouched: 0, recipientsProcessed: 0 };

  // Moderation review first (only does anything when isValidationAllowed
  // is on): campaigns that pass move to waiting_for_provider and get
  // picked up by the send step below in this same cycle.
  results.review = await runPendingReviews();

  if (!provider) {
    // No provider active — leave everything in waiting_for_provider
    // exactly as-is (spec §31). Nothing to do this cycle.
    return results;
  }

  const { data: campaigns, error } = await supabaseAdmin
    .from("campaigns")
    .select("*")
    .in("status", ["waiting_for_provider", "queued", "processing"])
    .order("started_at", { ascending: true })
    .limit(10); // a handful of campaigns per cycle keeps each run fast
  if (error) throw error;

  for (const campaign of campaigns || []) {
    if (inFlight.has(campaign.id)) continue; // an on-demand run is already on it
    inFlight.add(campaign.id);
    try {
      const outcome = await processCampaign(campaign, provider);
      results.campaignsTouched += 1;
      results.recipientsProcessed += outcome.processed;
    } finally {
      inFlight.delete(campaign.id);
    }
  }

  return results;
}

/**
 * Process ONE campaign right now (instead of waiting for the next scheduled
 * cycle): run its moderation review if it's pending one, then send batches
 * until nothing sendable is left or the drain cap is hit. Safe to call
 * repeatedly — a second call for a campaign already in flight is a no-op.
 * The scheduled cycle remains the safety net for retries and leftovers.
 */
export async function processCampaignNow(campaignId, log = console) {
  if (inFlight.has(campaignId)) return { skipped: "already_running" };
  inFlight.add(campaignId);
  try {
    // 1. Moderation review (no-op unless the campaign is pending_review).
    await runPendingReviews(log, { campaignId });

    const provider = resolveDeliveryProvider();
    if (!provider) return { skipped: "no_provider" };

    let campaign = await getCampaign(campaignId);
    if (!campaign || !["waiting_for_provider", "queued", "processing"].includes(campaign.status)) {
      return { skipped: `status_${campaign?.status ?? "missing"}` };
    }

    // 2. Drain.
    const startedAt = Date.now();
    let batches = 0;
    let recipientsProcessed = 0;
    while (batches < DRAIN_MAX_BATCHES && Date.now() - startedAt < DRAIN_MAX_MS) {
      const outcome = await processCampaign(campaign, provider);
      batches += 1;
      recipientsProcessed += outcome.processed;
      if (!outcome.processed) break;
      campaign = await getCampaign(campaignId);
      if (!campaign || !["waiting_for_provider", "queued", "processing"].includes(campaign.status)) break;
    }
    return { provider, batches, recipientsProcessed };
  } finally {
    inFlight.delete(campaignId);
  }
}
