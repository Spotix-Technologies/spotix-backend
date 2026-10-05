// v1/lib/mail/resend-client.js
//
// One shared Resend client for the ticket purchase confirmation email
// (v1/mail.js's /payment-confirmation route). Mirrors the
// v1/mail-routes/_mailjet-client.js convention — a single client
// instance, imported wherever it's needed, instead of re-constructing
// it per request.
//
// Only /payment-confirmation uses this. /booker-confirmation and
// /welcome-email still send via MailerSend (v1/mail.js) — this was a
// scoped swap for the ticket purchase email only.

import dotenv from "dotenv"
import { Resend } from "resend"

dotenv.config()

if (!process.env.RESEND_API_KEY) {
  // Non-fatal at import time — mirrors how the rest of the backend treats
  // missing mail provider keys (MailerSend, Mailjet). The first send
  // attempt will fail loudly instead, with Resend's own error message.
  console.warn("[resend-client] RESEND_API_KEY is not set — payment-confirmation emails will fail to send")
}

export const resend = new Resend(process.env.RESEND_API_KEY)
