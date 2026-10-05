/**
 * v1/lib/campaigns/delivery/resend-provider.js
 *
 * Reuses the existing shared Resend client (v1/lib/mail/resend-client.js)
 * rather than constructing a second one (spec §5).
 */

import { resend } from "../../mail/resend-client.js";
import { renderCampaignEmailHtml } from "../email-render.js";
import { createUnsubscribeUrl } from "../unsubscribe.js";

/** Sends one campaign email. Returns { providerMessageId }.
 *  Throws with `.transient = true` for retryable failures (rate limit,
 *  network, 5xx) and `.transient = false` for permanent ones (invalid
 *  address) — the worker uses this to decide retry vs. refund. */
export async function sendViaResend(campaign, recipient) {
  const unsubscribeUrl = createUnsubscribeUrl(campaign.organizer_id, recipient.email);
  const html = renderCampaignEmailHtml(campaign, unsubscribeUrl);

  try {
    const { data, error } = await resend.emails.send({
      from: `${campaign.sender_name} <${campaign.sender_email}>`,
      to: recipient.email,
      subject: campaign.subject,
      html,
      // Optional — set by the booker at creation time (spec ask). Omitted
      // entirely rather than passed as undefined/null so a reply just
      // goes to sender_email when the organizer didn't set one.
      ...(campaign.reply_to_address ? { replyTo: campaign.reply_to_address } : {}),
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>` },
      // Tags round-trip on every webhook event, so the webhook handler
      // can find the right campaign_recipients row without having to
      // search across all campaigns by provider_message_id.
      tags: [
        { name: "campaign_id", value: campaign.id },
        { name: "campaign_recipient_id", value: recipient.id },
      ],
    });
    if (error) throw error;
    return { providerMessageId: data?.id || null };
  } catch (err) {
    const message = String(err?.message || err);
    const permanent = /invalid|not a valid|domain is not verified|validation_error/i.test(message);
    const wrapped = new Error(message);
    wrapped.transient = !permanent;
    throw wrapped;
  }
}
