/**
 * v1/lib/campaigns/delivery/ses-provider.js
 *
 * New infra (spec §3) — the backend had no AWS SDK usage before this.
 * Requires the `@aws-sdk/client-ses` package to be added to
 * spotix-backend's dependencies (not in this zip — see PHASE-2-README).
 *
 * SES identity is the shared domain (SES_FROM_DOMAIN), campaign sender
 * addresses are dynamic local-parts under it (spec §3) — no per-campaign
 * SES identity verification is needed, only the domain itself.
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { renderCampaignEmailHtml } from "../email-render.js";
import { createUnsubscribeUrl } from "../unsubscribe.js";

let client;
function getClient() {
  if (!client) {
    client = new SESClient({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

export async function sendViaSES(campaign, recipient) {
  const unsubscribeUrl = createUnsubscribeUrl(campaign.organizer_id, recipient.email);
  const html = renderCampaignEmailHtml(campaign, unsubscribeUrl);

  const command = new SendEmailCommand({
    Source: `${campaign.sender_name} <${campaign.sender_email}>`,
    Destination: { ToAddresses: [recipient.email] },
    Message: {
      Subject: { Data: campaign.subject, Charset: "UTF-8" },
      Body: { Html: { Data: html, Charset: "UTF-8" } },
    },
    // Optional — set by the booker at creation time (spec ask). Omitted
    // entirely when unset so a reply just goes to sender_email.
    ...(campaign.reply_to_address ? { ReplyToAddresses: [campaign.reply_to_address] } : {}),
    Tags: [
      { Name: "campaign_id", Value: campaign.id },
      { Name: "campaign_recipient_id", Value: recipient.id },
    ],
    // Without this, SES sends the email through the default identity and
    // never publishes Send/Delivery/Bounce/etc. events to the SNS topic
    // wired up on the configuration set — the email still goes out, but
    // the webhook (v1/routes/webhooks/ses.js) never hears about it.
    ConfigurationSetName: process.env.SES_CONFIGURATION_SET_NAME,
  });

  try {
    const result = await getClient().send(command);
    return { providerMessageId: result.MessageId };
  } catch (err) {
    const message = String(err?.message || err);
    // SES throws MessageRejected for hard-invalid addresses; everything
    // else (throttling, ServiceUnavailable, network) is treated as
    // transient and retried (spec §33).
    const permanent = /MessageRejected|invalid/i.test(err?.name || "") || /invalid/i.test(message);
    const wrapped = new Error(message);
    wrapped.transient = !permanent;
    throw wrapped;
  }
}
