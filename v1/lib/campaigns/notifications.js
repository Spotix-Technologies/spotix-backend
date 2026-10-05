/**
 * v1/lib/campaigns/notifications.js
 *
 * Transactional emails to the ORGANIZER about their own campaign (not
 * the campaign emails themselves, which go through Resend/SES):
 *   - sendCampaignSentEmail    — the campaign finished sending
 *   - sendCampaignFlaggedEmail — moderation blocked it: why, and how to fix
 *
 * Sent through AWS SES (same as the SMS decision emails and credit receipts)
 * from campaign@booker.spotix.com.ng, as plain HTML. Recipient is the
 * organizer_email stored on the campaign row at creation time (resolved
 * server-side by spotix-booker, never taken from the browser).
 *
 * Never throws — a failed notification must never break the send cycle
 * or the request that triggered it.
 *
 * Env: BOOKER_APP_URL (already used by the mail-routes).
 */

import { sendViaSES } from "../mail/ses-client.js";
import { BRAND, COMPANY, renderEmailHeader } from "../mail/email-brand.js";
import { escapeHtml } from "./rich-text.js";

const FROM = "Spotix Campaigns <campaign@booker.spotix.com.ng>";

function bookerUrl() {
  return process.env.BOOKER_APP_URL || "https://booker.spotix.com.ng";
}

function layout({ heading, bodyHtml, ctaLabel, ctaUrl }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:${BRAND.pageBg};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.pageBg};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${BRAND.white};border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
        ${renderEmailHeader()}
        <tr><td style="padding:28px;color:${BRAND.bodyText};font-size:15px;line-height:1.6;">
          <h2 style="margin:0 0 14px;color:${BRAND.ink};font-size:20px;">${heading}</h2>
          ${bodyHtml}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;"><tr><td style="background:${BRAND.purple};border-radius:8px;">
            <a href="${ctaUrl}" style="display:inline-block;padding:12px 26px;color:#fff;font-weight:bold;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
          </td></tr></table>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid ${BRAND.purpleDivider};color:${BRAND.mutedLight};font-size:12px;">
          ${escapeHtml(COMPANY.name)} · ${escapeHtml(COMPANY.addressLine1)}, ${escapeHtml(COMPANY.addressLine2)}
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

async function deliver(campaign, subject, html, kind) {
  if (!campaign.organizer_email) {
    console.warn(`[campaign-notify] no organizer_email on campaign ${campaign.id}; skipped ${kind} email`);
    return false;
  }
  try {
    await sendViaSES({
      from: FROM,
      to: campaign.organizer_email,
      subject,
      html,
      configurationSetName: "tracking", // Enables click tracking via the custom tracking domain
    });
    return true;
  } catch (err) {
    console.error(`[campaign-notify] ${kind} email failed for campaign ${campaign.id}:`, err?.message || err);
    return false;
  }
}

export async function sendCampaignSentEmail(campaign) {
  const url = `${bookerUrl()}/campaign/${campaign.id}`;
  const name = escapeHtml(campaign.name);
  const withErrors = campaign.status === "completed_with_errors";
  const html = layout({
    heading: "Your campaign was sent",
    bodyHtml: `<p style="margin:0 0 12px;">Your campaign <strong>${name}</strong> has been sent out successfully.${withErrors ? " A few emails couldn't be delivered — the campaign page shows which ones." : ""}</p>
      <p style="margin:0;">You can monitor opens, clicks and delivery any time at<br/><a href="${url}" style="color:${BRAND.purple};">${escapeHtml(url)}</a></p>`,
    ctaLabel: "View campaign",
    ctaUrl: url,
  });
  return deliver(campaign, `Your campaign "${campaign.name}" was sent`, html, "sent");
}

export async function sendCampaignFlaggedEmail(campaign) {
  const url = `${bookerUrl()}/campaign/create?resume=${campaign.id}`;
  const name = escapeHtml(campaign.name);
  const reason = escapeHtml(campaign.moderation_reason || "Our review found an issue with this message.");
  const suggestion = campaign.moderation_suggestion
    ? `<p style="margin:0 0 12px;"><strong>How to fix it:</strong> ${escapeHtml(campaign.moderation_suggestion)}</p>`
    : "";
  const html = layout({
    heading: "We couldn't send your campaign yet",
    bodyHtml: `<p style="margin:0 0 12px;">Our review of <strong>${name}</strong> found a problem, so it hasn't been sent and no credits were used.</p>
      <p style="margin:0 0 12px;"><strong>Why:</strong> ${reason}</p>
      ${suggestion}
      <p style="margin:0;">Update the message and resubmit — your audience and details are already saved.</p>`,
    ctaLabel: "Fix and resubmit",
    ctaUrl: url,
  });
  return deliver(campaign, `Action needed: "${campaign.name}" wasn't sent`, html, "flagged");
}
