/**
 * v1/lib/campaigns/email-render.js
 *
 * Renders the final campaign email HTML (spec §26–28, §54). The wrapper
 * (page background, table shell) is shared; the 3 template bodies live
 * in templates.js. Server always controls the CTA URL (spec §27) —
 * never trusts a frontend-supplied link — and the organizer's message
 * only ever arrives as escaped plain text (formatMessage), never raw
 * HTML (spec §26).
 */

import { BRAND, COMPANY } from "../mail/email-brand.js";
import { renderTemplateBody, formatMessage } from "./templates.js";

const SPOTIX_USER_URL = process.env.NEXT_PUBLIC_SPOTIX_USER || "https://spotix.com.ng";

export function renderCampaignEmailHtml(campaign, unsubscribeUrl) {
  const eventUrl = `${SPOTIX_USER_URL}/event/${campaign.event_slug_snapshot}`;
  const message = campaign.message_text
    ? formatMessage(campaign.message_text)
    : `<p style="margin:0 0 16px;">${(campaign.name || "").replace(/[<>&]/g, "")}</p>`;
  const color = /^#[0-9a-fA-F]{6}$/.test(campaign.brand_color || "") ? campaign.brand_color : BRAND.purple;
  const footer = `${(COMPANY.name || "").replace(/[<>&]/g, "")} · ${(COMPANY.addressLine1 || "")}, ${(COMPANY.addressLine2 || "")}<br/>
    <a href="${unsubscribeUrl}" style="color:inherit;">Unsubscribe from campaign emails</a>`;

  const bodyTable = renderTemplateBody(campaign.template_id, {
    eventName: campaign.event_name_snapshot,
    message,
    color,
    eventUrl,
    unsubscribeUrl,
    footer,
    ctaText: campaign.cta_text,
  });

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:${BRAND.pageBg};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.pageBg};padding:24px 0;">
    <tr><td align="center">${bodyTable}</td></tr>
  </table>
</body>
</html>`;
}
