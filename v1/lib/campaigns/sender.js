/**
 * v1/lib/campaigns/sender.js
 *
 * Generates the read-only campaign sender address (spec §3, §23):
 * "notification@booker.spotix.com.ng" for every event. Organizers never
 * choose or edit this technical address — the event's own name is still
 * what recipients see, via sender_name (campaign.sender_name /
 * repo.js#createCampaign), not this local part. A single shared local
 * part (rather than one derived per-event) keeps SES/Resend deliverability
 * reputation pooled on one consistent address instead of spreading it
 * across a new local part per event.
 */

const SES_FROM_DOMAIN = process.env.SES_FROM_DOMAIN || "booker.spotix.com.ng";
const SENDER_LOCAL_PART = "notification";

export function generateSenderEmail() {
  return `${SENDER_LOCAL_PART}@${SES_FROM_DOMAIN}`;
}
