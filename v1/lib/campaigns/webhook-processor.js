/**
 * v1/lib/campaigns/webhook-processor.js
 *
 * Shared by the Resend and SES/SNS webhook routes — both providers
 * ultimately resolve to the same (campaignId, recipientId, eventType)
 * shape, so the idempotency + state-transition logic only needs to
 * live once (spec §4/§34).
 */

import {
  insertEmailEvent, updateRecipient, updateRecipientIfStatusIn, getCampaign,
  recomputeCampaignAggregates, setUnsubscribed,
} from "./repo.js";
import { consumeRecipientCredit, refundRecipientCredit } from "./credits.js";

const TIMESTAMP_FIELD = {
  sent: "sent_at", delivered: "delivered_at", opened: "opened_at",
  clicked: "clicked_at", bounced: "bounced_at", failed: "failed_at",
  delayed: "delayed_at",
};

// The funnel a recipient normally moves through. Providers don't
// guarantee webhook delivery order (retries, provider-side queueing,
// concurrent requests to this server), so a "sent" event arriving after
// a "delivered" one is a real, observed case — not hypothetical. Without
// a forward-only guard, that "sent" event blindly overwrites `status`
// back from "delivered" to "sent", which is exactly what was making
// delivered_count sit at 0 despite delivered webhooks having landed.
const FUNNEL_ORDER = ["pending", "sending", "sent", "delivered", "opened", "clicked"];

// Permanent outcomes: the reserved credit becomes reusable again (spec §14).
const PERMANENT_STATUSES = new Set(["bounced", "complained", "failed"]);

// Informational events that are NOT part of the funnel above — a
// DeliveryDelay/email.delivery_delayed doesn't mean anything landed or
// advanced (the send is still in flight; a later delivered/bounced event
// resolves it), so it must never touch `status`. It still gets its own
// timestamp (delayed_at) and its own row in the immutable email_events
// ledger, same as every other event.
const NON_FUNNEL_INFO_EVENTS = new Set(["delayed"]);

export async function applyDeliveryEvent({
  campaignId, campaignRecipientId, provider, providerEventId, eventType, payload,
}) {
  const { duplicate } = await insertEmailEvent({
    campaignId, campaignRecipientId, provider, providerEventId, eventType, payload,
  });
  if (duplicate) return { applied: false, reason: "duplicate_event" };

  const campaign = await getCampaign(campaignId);
  if (!campaign) return { applied: false, reason: "campaign_not_found" };

  const tsField = TIMESTAMP_FIELD[eventType];
  const tsPatch = tsField ? { [tsField]: new Date().toISOString() } : {};

  if (NON_FUNNEL_INFO_EVENTS.has(eventType)) {
    // Record the timestamp only — status is untouched, this is purely
    // "FYI, this send is running slow."
    if (tsField) await updateRecipient(campaignRecipientId, tsPatch);
  } else if (PERMANENT_STATUSES.has(eventType)) {
    // Terminal outcomes always win — a bounce/complaint/failure needs to
    // be recorded (and its credit refunded) even if it happens to race
    // with an earlier funnel event, rather than being silently dropped
    // because some other status already landed.
    await updateRecipient(campaignRecipientId, { status: eventType, ...tsPatch });
  } else {
    // Only move status forward (or restate the current stage) — never
    // let an event still in flight clobber one that already landed
    // further down the funnel. Single atomic `UPDATE ... WHERE status
    // IN (...)`, so this is safe even if two events for the same
    // recipient are being processed concurrently.
    const funnelIdx = FUNNEL_ORDER.indexOf(eventType);
    const allowedPriorStatuses = FUNNEL_ORDER.slice(0, funnelIdx + 1);
    const updated = await updateRecipientIfStatusIn(
      campaignRecipientId,
      { status: eventType, ...tsPatch },
      allowedPriorStatuses
    );
    if (updated.length === 0 && tsField) {
      // Status was already further along (or terminal) than this event —
      // still worth recording the timestamp for the audit trail without
      // touching status.
      await updateRecipient(campaignRecipientId, tsPatch);
    }
  }

  if (eventType === "delivered") {
    await consumeRecipientCredit(campaign.organizer_id, campaignId, campaign.event_id);
  } else if (PERMANENT_STATUSES.has(eventType)) {
    await refundRecipientCredit(campaign.organizer_id, campaignId, campaign.event_id);
  }

  if (eventType === "complained") {
    // A spam complaint is an implicit opt-out (spec §55) — don't wait
    // for the recipient to click Unsubscribe.
    const recipient = payload?.recipientEmail;
    if (recipient) await setUnsubscribed(campaign.organizer_id, recipient, true);
  }

  await recomputeCampaignAggregates(campaignId);
  return { applied: true };
}
