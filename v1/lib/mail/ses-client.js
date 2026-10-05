// v1/lib/mail/ses-client.js
//
// One shared AWS SES client for the ticket purchase confirmation email
// (v1/mail.js's /payment-confirmation route). Mirrors the
// v1/lib/mail/resend-client.js convention it replaces — a single client
// instance, imported wherever it's needed, instead of re-constructing
// it per request.
//
// By default this does NOT set a ConfigurationSetName on the send — unlike
// v1/lib/campaigns/delivery/ses-provider.js (the campaigns sender),
// this route has no SNS-backed webhook listening for delivery events,
// so there is nothing for a configuration set to notify. Leaving it
// unset just means SES delivers the email through the default identity
// with no event publishing — no webhook is ever expected to fire for
// this route.
//
// Callers can opt in to a configuration set by passing `configurationSetName`
// (the "tracking" set is used for click tracking on ticket confirmation emails
// and SMS decision emails).
//
// Used by /payment-confirmation (ticket delivery, from tickets@hello.spotix.com.ng),
// the credit purchase receipts and the SMS decision emails.
// /booker-confirmation and /welcome-email still send via MailerSend
// (v1/routes/mail.js) on hosted templates.

import dotenv from "dotenv"
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses"

dotenv.config()

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  // Non-fatal at import time — mirrors how the rest of the backend treats
  // missing mail provider keys (MailerSend, Resend). The first send
  // attempt will fail loudly instead, with SES's own error message.
  console.warn("[ses-client] AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are not set — payment-confirmation emails will fail to send")
}

let client
function getClient() {
  if (!client) {
    client = new SESClient({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    })
  }
  return client
}

/**
 * @param {Object} params
 * @param {string} params.from - "Display Name <address@domain>"
 * @param {string} params.to - recipient email address
 * @param {string} params.subject
 * @param {string} params.html
 * @param {string} [params.configurationSetName] - optional SES configuration set (e.g. "tracking")
 */
export async function sendViaSES({ from, to, subject, html, configurationSetName }) {
  const command = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: { Html: { Data: html, Charset: "UTF-8" } },
    },
    // Optional. When omitted, SES delivers the email with no event publishing.
    ...(configurationSetName ? { ConfigurationSetName: configurationSetName } : {}),
  })

  try {
    const result = await getClient().send(command)
    return { providerMessageId: result.MessageId }
  } catch (err) {
    throw new Error(err?.message || "AWS SES failed to send the email")
  }
}