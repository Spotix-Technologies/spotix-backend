// v1/lib/sms/notifications.js
//
// Email to the booker (via SES) when an admin approves or rejects their bulk
// SMS. Greeting is "Good {morning|afternoon|evening} {bookerUsername}", then
// which campaign (by event name + created date) and the outcome — with the
// admin's reason when rejected. Footer (with the current year) comes from
// email-brand.js via the shared transactional layout.
//
// Never throws.

import { sendViaSES } from "../mail/ses-client.js";
import { generateSenderEmail } from "../campaigns/sender.js";
import { renderTransactionalEmail, escapeHtml } from "../mail/transactional-layout.js";
import { timeOfDay, formatLongDate } from "../mail/email-brand.js";

function bookerUrl() {
  return process.env.BOOKER_APP_URL || "https://booker.spotix.com.ng";
}

/**
 * @param {Object} campaign  a row from sms_campaign
 * @param {"approved"|"rejected"} decision
 */
export async function sendSmsDecisionEmail(campaign, decision) {
  try {
    if (!campaign.organizer_email) {
      console.warn(`[sms-notify] no organizer_email on sms campaign ${campaign.id}; skipped ${decision} email`);
      return false;
    }

    const approved = decision === "approved";
    const username = escapeHtml(campaign.organizer_username || "there");
    const eventName = escapeHtml(campaign.event_name_snapshot);
    const created = escapeHtml(formatLongDate(campaign.created_at));

    const reasonBlock = !approved
      ? `<div style="margin:14px 0;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#7f1d1d;">
           <strong>Reason:</strong> ${escapeHtml(campaign.rejection_reason || "No reason was provided.")}
         </div>
         <p style="margin:0 0 12px;">The ${Number(campaign.credits_reserved).toLocaleString("en-NG")} credits reserved for it have been returned to your SMS credit balance. You can edit the message and send it again from your campaigns page.</p>`
      : `<p style="margin:0 0 12px;">It's now queued for delivery. We'll mark it as delivered once it has been sent.</p>`;

    const html = renderTransactionalEmail({
      heading: approved ? "Your bulk SMS was approved🥳" : "Your bulk SMS was rejected😣",
      bodyHtml: `<p style="margin:0 0 12px;">Good ${timeOfDay()} ${username},</p>
        <p style="margin:0 0 12px;">Your bulk SMS created under <strong>${eventName}</strong> on <strong>${created}</strong> was <strong>${approved ? "approved" : "rejected"}</strong>.</p>
        ${reasonBlock}`,
      ctaLabel: approved ? "View campaigns" : "Fix and resend",
      ctaUrl: approved
        ? `${bookerUrl()}/campaign`
        : `${bookerUrl()}/campaign/sms/create?resendFrom=${encodeURIComponent(campaign.id)}`,
    });

    await sendViaSES({
      from: `Spotix Booker <${generateSenderEmail()}>`,
      to: campaign.organizer_email,
      subject: approved ? "Your bulk SMS was approved🥳" : "Your bulk SMS was rejected😣",
      html,
      configurationSetName: "tracking", // Enables click tracking via the custom tracking domain
    });
    return true;
  } catch (err) {
    console.error(`[sms-notify] ${decision} email failed for sms campaign ${campaign?.id}:`, err?.message || err);
    return false;
  }
}