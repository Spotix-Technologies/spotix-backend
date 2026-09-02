// v1/lib/mail/ticket-confirmation-template.js
//
// Builds the full HTML for the buyer's ticket confirmation email.
//
// Why this exists instead of MailerSend's hosted template_id:
// MailerSend's drag-and-drop template editor can't loop over an array, so
// it can't render "one QR block per ticket" for multi-ticket purchases.
// Building the HTML here in code gives us that loop (renderTicketRow()
// below) while keeping every other design decision in one readable place.
//
// Each ticket's QR is a self-hosted <img>, generated on the fly by
// v1/qrcode.js from the raw ticketId — the exact value your check-in
// scanner already reads (see ticket-agent.js). No third-party QR service,
// no base64 images (those get stripped by several email clients).

import { BRAND, BRAND_GRADIENT, COMPANY } from "./email-brand.js";

/**
 * Minimal HTML-escaping for values interpolated into the email — these
 * ultimately trace back to booker/event input, so treat them as untrusted.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * One ticket = one row: QR on the left, ID + type on the right. Stacks
 * vertically on mobile via the .ticket-row / .ticket-qr-cell classes
 * defined in the <style> block below.
 */
function renderTicketRow({ ticketId, ticketType }, index, total, qrBaseUrl) {
  const safeId = escapeHtml(ticketId);
  const safeType = escapeHtml(ticketType || "Standard");
  const qrSrc = `${qrBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(ticketId)}.png?size=240`;
  const isLast = index === total - 1;

  return `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" class="ticket-row" style="border-collapse:collapse;${isLast ? "" : `margin-bottom:16px;`}">
      <tr>
        <td style="background:rgba(255,255,255,0.6);border:1.5px solid ${BRAND.purpleBorder};border-radius:10px;padding:0;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
            <tr>
              <td class="ticket-qr-cell" width="130" valign="middle" align="center" style="padding:16px;">
                <img src="${qrSrc}" width="110" height="110" alt="QR code for ticket ${safeId}"
                     style="display:block;border-radius:8px;border:1px solid ${BRAND.purpleDivider};width:110px;height:110px;" />
              </td>
              <td valign="middle" style="padding:16px 20px 16px 4px;">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:${BRAND.purpleLight};padding-bottom:6px;">
                  Ticket ${total > 1 ? `${index + 1} of ${total}` : ""}
                </div>
                <div style="font-size:15px;font-weight:700;color:${BRAND.ink};padding-bottom:6px;word-break:break-all;line-height:22px;">
                  ${safeId}
                </div>
                <div style="font-size:13px;color:${BRAND.muted};">
                  ${safeType}
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
}

/**
 * @param {Object} params
 * @param {string} params.name - buyer's display name
 * @param {string} params.eventName
 * @param {string} params.eventHost
 * @param {string} params.paymentRef
 * @param {string} params.ticketTypesSummary - e.g. "VIP x2, Regular"
 * @param {string} params.totalAmount - pre-formatted, e.g. "15,000.00"
 * @param {number} params.ticketCount
 * @param {string} params.paymentMethod
 * @param {string} params.bookerEmail
 * @param {{ ticketId: string, ticketType: string }[]} params.tickets - one entry per physical ticket, in order
 * @param {string} params.qrBaseUrl - e.g. "https://api.spotix.com.ng/v1/qrcode"
 * @returns {string} full HTML document, ready to hand to an ESP's `html` field
 */
export function buildTicketConfirmationEmailHtml({
  name,
  eventName,
  eventHost,
  paymentRef,
  ticketTypesSummary,
  totalAmount,
  ticketCount,
  paymentMethod,
  bookerEmail,
  tickets,
  qrBaseUrl,
}) {
  const safeName = escapeHtml(name);
  const safeEventName = escapeHtml(eventName);
  const safeEventHost = escapeHtml(eventHost);
  const safePaymentRef = escapeHtml(paymentRef);
  const safeTicketTypes = escapeHtml(ticketTypesSummary);
  const safePaymentMethod = escapeHtml(paymentMethod);
  const isMultiple = Number(ticketCount) > 1;

  const ticketRowsHtml = (tickets || [])
    .map((t, i) => renderTicketRow(t, i, tickets.length, qrBaseUrl))
    .join("");

  const mailtoBody = encodeURIComponent(
    `Hi ${eventHost},\n\nI purchased a ${ticketTypesSummary} ticket to your event (Ref: ${paymentRef}). I have a question.`
  );
  const mailtoSubject = encodeURIComponent(`Enquiry about ${eventName}`);

  return `<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Spotix Ticket Confirmation</title>
    <!--[if !mso]><!-->
    <style type="text/css">
        @import url('https://fonts.mailersend.com/css?family=Inter:400,500,600,700');
    </style>
    <!--<![endif]-->
    <style type="text/css" rel="stylesheet" media="all">
        @media only screen and (max-width: 640px) {
            .ms-header { display: none !important; }
            .ms-content { width: 100% !important; border-radius: 0; }
            .ms-content-body { padding: 24px !important; }
            .ms-footer { width: 100% !important; }
            .mobile-wide { width: 100% !important; }
            .hero-pad { padding: 28px 24px !important; }
            .table-cell { padding-top: 10px !important; padding-bottom: 10px !important; }
            .ticket-qr-cell { display: block !important; width: 100% !important; padding-bottom: 0 !important; }
        }
    </style>
    <!--[if mso]>
    <style type="text/css">
        body, td, td *, td p, td a, td span, td div, td ul li, td ol li, td blockquote, th * {
            font-family: Arial, Helvetica, sans-serif !important;
        }
    </style>
    <![endif]-->
</head>
<body style="font-family:'Inter', Helvetica, Arial, sans-serif; width:100% !important; height:100%; margin:0; padding:0; -webkit-text-size-adjust:none; background-color:${BRAND.pageBg}; color:${BRAND.ink};">

    <div class="preheader" style="display:none !important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
        Your Spotix ticket${isMultiple ? "s" : ""} for ${safeEventName} ${isMultiple ? "are" : "is"} confirmed — ${safeTicketTypes} · Ref: ${safePaymentRef}
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;background-color:${BRAND.pageBg};">
        <tr>
            <td align="center" style="font-family:'Inter', Helvetica, Arial, sans-serif;font-size:16px;line-height:24px;padding:32px 0 0;">

                <!-- ── LOGO BAR ── -->
                <table width="640" cellpadding="0" cellspacing="0" class="ms-header" style="border-collapse:collapse;max-width:640px;width:100%;">
                    <tr>
                        <td align="center" style="padding-bottom:24px;">
                            <span style="font-size:22px;font-weight:700;color:${BRAND.purple};letter-spacing:-0.3px;">✦ Spotix</span>
                        </td>
                    </tr>
                </table>

                <!-- ── MAIN CARD ── -->
                <table class="ms-content" width="640" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:640px;max-width:640px;margin:0 auto;background-color:${BRAND.white};border-radius:16px;box-shadow:0 8px 32px rgba(107,47,165,0.14);overflow:hidden;">

                    <!-- HERO BAND (frosted-glass inspired: layered translucent panel on the brand gradient — true CSS blur isn't supported by email clients, this is the closest reliable approximation) -->
                    <tr>
                        <td class="hero-pad" style="background:${BRAND_GRADIENT};padding:44px 50px 40px;text-align:center;">
                            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
                                <tr>
                                    <td align="center" style="background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.35);border-radius:16px;padding:28px 20px;">
                                        <img
                                          src="https://snguq.mjt.lu/img2/snguq/d1247179-8d20-40d9-9503-88ebd4b9587e/content"
                                          alt="Spotix"
                                          width="80"
                                          height="80"
                                          style="display:block;margin:0 auto 14px;border-radius:50%;background-color:${BRAND.purple};padding:10px;"
                                        />
                                        <h1 style="margin:0 0 8px;color:${BRAND.white};font-size:26px;line-height:34px;font-weight:700;">You're going!</h1>
                                        <p style="margin:0;color:rgba(255,255,255,0.9);font-size:15px;line-height:22px;">Your ticket purchase was successful</p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- BODY -->
                    <tr>
                        <td class="ms-content-body" style="padding:40px 50px;font-family:'Inter', Helvetica, Arial, sans-serif;font-size:16px;line-height:26px;color:${BRAND.bodyText};">

                            <p style="margin:0 0 28px;font-size:16px;line-height:26px;color:${BRAND.bodyText};">
                                Hi <strong style="color:${BRAND.ink};">${safeName}</strong>, your ticket
                                ${isMultiple ? "s are" : " is"} confirmed for
                                <strong style="color:${BRAND.purple};">${safeEventName}</strong>.
                                Here's a summary of your order.
                            </p>

                            <!-- EVENT HIGHLIGHT BOX -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:28px;">
                                <tr>
                                    <td style="background:${BRAND.purpleSoft};border:1.5px solid ${BRAND.purpleBorder};border-radius:10px;padding:20px 24px;">
                                        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                                            <tr>
                                                <td style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${BRAND.purpleLight};padding-bottom:6px;">Event</td>
                                            </tr>
                                            <tr>
                                                <td style="font-size:18px;font-weight:700;color:${BRAND.ink};padding-bottom:12px;line-height:26px;">${safeEventName}</td>
                                            </tr>
                                            <tr>
                                                <td style="font-size:14px;color:${BRAND.muted};">
                                                    Organised by <strong style="color:${BRAND.purple};">${safeEventHost}</strong>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <!-- ── YOUR TICKETS: one card + QR per ticket ── -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
                                <tr>
                                    <td style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${BRAND.purpleLight};padding-bottom:12px;border-bottom:2px solid ${BRAND.purpleBorder};">
                                        Your Ticket${isMultiple ? "s" : ""} — scan at the door
                                    </td>
                                </tr>
                            </table>
                            <div style="margin-bottom:28px;">
                                ${ticketRowsHtml}
                            </div>

                            <!-- ORDER DETAILS TABLE -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:28px;">

                                <tr>
                                    <td colspan="2" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${BRAND.purpleLight};padding-bottom:12px;border-bottom:2px solid ${BRAND.purpleBorder};">
                                        Order Details
                                    </td>
                                </tr>

                                <tr>
                                    <td class="table-cell" valign="middle" style="font-size:15px;color:${BRAND.muted};padding:14px 0;border-bottom:1px solid ${BRAND.purpleDivider};width:45%;">
                                        Ticket Type${isMultiple ? "s" : ""}
                                    </td>
                                    <td class="table-cell" valign="middle" align="right" style="font-size:15px;font-weight:600;color:${BRAND.ink};padding:14px 0;border-bottom:1px solid ${BRAND.purpleDivider};">
                                        ${safeTicketTypes}
                                    </td>
                                </tr>

                                <tr>
                                    <td class="table-cell" valign="middle" style="font-size:15px;color:${BRAND.muted};padding:14px 0;border-bottom:1px solid ${BRAND.purpleDivider};">
                                        Quantity
                                    </td>
                                    <td class="table-cell" valign="middle" align="right" style="font-size:15px;font-weight:600;color:${BRAND.ink};padding:14px 0;border-bottom:1px solid ${BRAND.purpleDivider};">
                                        ${Number(ticketCount) || 1}
                                    </td>
                                </tr>

                                <tr>
                                    <td class="table-cell" valign="middle" style="font-size:15px;color:${BRAND.muted};padding:14px 0;border-bottom:1px solid ${BRAND.purpleDivider};">
                                        Payment Method
                                    </td>
                                    <td class="table-cell" valign="middle" align="right" style="font-size:15px;font-weight:600;color:${BRAND.ink};padding:14px 0;border-bottom:1px solid ${BRAND.purpleDivider};">
                                        ${safePaymentMethod}
                                    </td>
                                </tr>

                                <tr>
                                    <td class="table-cell" valign="middle" style="font-size:15px;color:${BRAND.muted};padding:14px 0;border-bottom:1px solid ${BRAND.purpleDivider};">
                                        Payment Reference
                                    </td>
                                    <td class="table-cell" valign="middle" align="right" style="font-size:13px;font-weight:600;color:${BRAND.ink};padding:14px 0;border-bottom:1px solid ${BRAND.purpleDivider};word-break:break-all;">
                                        ${safePaymentRef}
                                    </td>
                                </tr>

                                <tr>
                                    <td class="table-cell" valign="middle" style="font-size:16px;font-weight:700;color:${BRAND.ink};padding:18px 0 4px;">
                                        Total Paid
                                    </td>
                                    <td class="table-cell" valign="middle" align="right" style="font-size:20px;font-weight:700;color:${BRAND.purple};padding:18px 0 4px;">
                                        ₦${escapeHtml(totalAmount)}
                                    </td>
                                </tr>

                            </table>

                            <!-- CTA BUTTON -->
                            <table width="100%" align="center" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:32px;">
                                <tr>
                                    <td align="center" style="padding:8px 0 0;">
                                        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                                            <tr>
                                                <td align="center" style="background-color:${BRAND.purple};border-radius:8px;box-shadow:0 4px 14px rgba(107,47,165,0.35);">
                                                    <a href="${COMPANY.siteUrl}/ticket-history" target="_blank"
                                                       style="display:inline-block;padding:14px 36px;color:${BRAND.white};font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;letter-spacing:0.2px;">
                                                        View My Tickets →
                                                    </a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <!-- CONTACT NOTE -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
                                <tr>
                                    <td style="background:#f9fafb;border-left:3px solid ${BRAND.purple};border-radius:0 6px 6px 0;padding:16px 20px;font-size:14px;color:${BRAND.bodyText};line-height:22px;">
                                        Got a question about this event? Reply to this email or
                                        <a href="mailto:${escapeHtml(bookerEmail)}?subject=${mailtoSubject}&body=${mailtoBody}"
                                           style="color:${BRAND.purple};font-weight:600;text-decoration:none;">contact the event planner</a> directly.
                                    </td>
                                </tr>
                            </table>

                            <p style="margin:0;font-size:15px;color:${BRAND.bodyText};line-height:24px;">
                                Cheers &amp; see you there! 🎉<br>
                                <strong style="color:${BRAND.purple};">Your friends at Spotix</strong>
                            </p>

                            <!-- DIVIDER -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:32px;">
                                <tr>
                                    <td style="border-top:1px solid ${BRAND.purpleDivider};padding-top:24px;font-size:13px;color:${BRAND.mutedLight};line-height:20px;">
                                        This event is not directly organised by Spotix. If the event date, time or venue changes, or the event is cancelled, you are entitled to a full refund. Contact us at
                                        <a href="mailto:${COMPANY.supportEmail}" style="color:${BRAND.purple};text-decoration:none;">${COMPANY.supportEmail}</a> for any concerns.
                                    </td>
                                </tr>
                            </table>

                        </td>
                    </tr>

                    <!-- FOOTER -->
                    <tr>
                        <td align="center" style="background:${BRAND.purpleSoft};border-top:1px solid ${BRAND.purpleBorder};padding:28px 50px;font-family:'Inter', Helvetica, Arial, sans-serif;">
                            <p style="margin:0 0 6px;font-size:13px;color:${BRAND.purpleLight};font-weight:600;">Spotix Tickets</p>
                            <p style="margin:0 0 6px;font-size:12px;color:${BRAND.mutedLight};line-height:20px;">
                                ${COMPANY.addressLine1}<br>
                                ${COMPANY.addressLine2}
                            </p>
                            <p style="margin:8px 0 0;font-size:12px;color:#c4b5d9;">
                                &copy; ${new Date().getFullYear()} Spotix Technologies. All rights reserved.
                            </p>
                        </td>
                    </tr>

                </table>
                <!-- end main card -->

                <table width="640" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:640px;width:100%;">
                    <tr><td height="40">&nbsp;</td></tr>
                </table>

            </td>
        </tr>
    </table>

</body>
</html>`;
}
