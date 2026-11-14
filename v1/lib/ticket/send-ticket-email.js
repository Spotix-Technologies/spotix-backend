// v1/lib/ticket/send-ticket-email.js
//
// The one place that turns "this person holds these tickets" into the
// ticket email: HTML body + ticket.pdf + invite.ics, sent via SES.
//
// Used by both:
//   - POST /v1/mail/payment-confirmation  (purchase confirmation, v1/routes/mail.js)
//   - the "email me my tickets" lookup     (v1/lib/ticket/resend-tickets.js)
// so the two emails can never drift apart.
//
// The attachments are a bonus on top of the ticket itself: if the PDF or the
// calendar invite can't be generated — or SES rejects the attachment
// version — the buyer still gets the plain email with the inline QR codes.

import { buildTicketConfirmationEmailHtml } from "../mail/ticket-confirmation-template.js";
import { sendViaSES } from "../mail/ses-client.js";
import { COMPANY } from "../mail/email-brand.js";
import { buildTicketsPdf } from "./ticket-pdf.js";
import { buildCalendarInvite, formatEventWhen, eventPageUrl } from "./calendar-invite.js";

// Base URL the QR <img> tags in the ticket email point at — v1/routes/qrcode.js
// is registered under this same backend. Set QR_BACKEND_URL if QR images
// should be served from a different host (e.g. a CDN in front of this API).
export const QR_BASE_URL = process.env.QR_BACKEND_URL || "http://localhost:2000";

// Past this many tickets the body lists the first few QRs and points at the
// attached PDF for the rest (keeps the email under Gmail's ~102KB clip limit).
const MAX_INLINE_TICKETS = 25;

const FROM = "Spotix Tickets <tickets@hello.spotix.com.ng>";

/**
 * @param {Object} p
 * @param {{ info: Function, warn: Function }} [p.log]
 * @param {string} p.to
 * @param {string} p.name - buyer / holder display name
 * @param {string} [p.subject]
 * @param {string} [p.eventId]
 * @param {string} p.eventName
 * @param {string} p.eventHost
 * @param {string} [p.eventImage]
 * @param {string} [p.eventVenue]
 * @param {string} [p.eventDate] / p.eventStart / p.eventEndDate / p.eventEnd - used for invite.ics + the date line
 * @param {string} p.paymentRef - one reference, or several joined with ", "
 * @param {string} p.ticketTypesSummary - e.g. "VIP x2, Regular"
 * @param {string} p.totalAmount - pre-formatted, e.g. "15000.00"
 * @param {number} p.ticketCount
 * @param {string} p.paymentMethod
 * @param {string} p.bookerEmail
 * @param {{ ticketId: string, ticketType: string }[]} p.tickets
 */
export async function sendTicketEmail({
  log,
  to,
  name,
  subject,
  eventId,
  eventName,
  eventHost,
  eventImage,
  eventVenue,
  eventDate,
  eventStart,
  eventEndDate,
  eventEnd,
  paymentRef,
  ticketTypesSummary,
  totalAmount,
  ticketCount,
  paymentMethod,
  bookerEmail,
  tickets,
}) {
  const eventWhen = formatEventWhen({ eventDate, eventStart, eventEndDate, eventEnd });

  // ── Attachments (each best-effort, independently) ──
  const attachments = [];

  try {
    const pdf = await buildTicketsPdf({
      tickets,
      eventName,
      eventHost,
      eventVenue,
      eventWhen,
      holderName: name,
      paymentRef,
      supportEmail: COMPANY.supportEmail,
    });
    attachments.push({ filename: "ticket.pdf", contentType: "application/pdf", content: pdf });
  } catch (err) {
    log?.warn?.(`[ticket-email] ticket.pdf skipped: ${err.message}`);
  }

  try {
    const ics = buildCalendarInvite({
      // Stable per (event, purchase): re-sending the email updates the same calendar entry.
      uid: `${eventId || eventName}-${String(paymentRef).split(",")[0].trim()}@spotix.com.ng`,
      title: eventName,
      location: eventVenue,
      description: [
        `Your ticket${tickets.length > 1 ? "s" : ""} for ${eventName}.`,
        `Ticket ID${tickets.length > 1 ? "s" : ""}: ${tickets.map((t) => t.ticketId).join(", ")}`,
        `Organised by ${eventHost}.`,
        `Questions? ${bookerEmail}`,
      ].join("\n"),
      url: eventPageUrl(eventId),
      eventDate,
      eventStart,
      eventEndDate,
      eventEnd,
    });
    if (ics) attachments.push({ filename: "invite.ics", contentType: "text/calendar; charset=UTF-8; method=PUBLISH", content: ics });
  } catch (err) {
    log?.warn?.(`[ticket-email] invite.ics skipped: ${err.message}`);
  }

  const buildHtml = (withAttachments) =>
    buildTicketConfirmationEmailHtml({
      name,
      eventName,
      eventHost: eventHost || "Spotix Event Host",
      paymentRef,
      ticketTypesSummary,
      totalAmount,
      ticketCount,
      paymentMethod,
      bookerEmail,
      tickets,
      qrBaseUrl: QR_BASE_URL,
      eventImage: eventImage || "",
      eventWhen,
      eventVenue,
      hasAttachments: withAttachments,
      maxInlineTickets: withAttachments ? MAX_INLINE_TICKETS : Infinity,
    });

  const plainText = [
    `Hi ${name}, your ticket${tickets.length > 1 ? "s are" : " is"} confirmed for ${eventName}.`,
    ...(eventWhen ? [`When: ${eventWhen}`] : []),
    ...(eventVenue ? [`Where: ${eventVenue}`] : []),
    "",
    ...tickets.map((t, i) => `Ticket ${i + 1}: ${t.ticketId} (${t.ticketType || "Standard"})`),
    "",
    `Payment reference: ${paymentRef}`,
    "Your ticket PDF and calendar invite are attached. Show the QR code at the entrance.",
    "",
    `Questions? ${bookerEmail}`,
  ].join("\n");

  const common = { from: FROM, to, subject: subject || `Your Ticket for ${eventName}`, configurationSetName: "tracking" };

  if (attachments.length) {
    try {
      await sendViaSES({ ...common, html: buildHtml(true), text: plainText, attachments });
      return { attachments: attachments.map((a) => a.filename) };
    } catch (err) {
      log?.warn?.(`[ticket-email] send with attachments failed (${err.message}) — retrying without them`);
    }
  }

  await sendViaSES({ ...common, html: buildHtml(false) });
  return { attachments: [] };
}
