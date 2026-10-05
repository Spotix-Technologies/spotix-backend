// v1/lib/campaigns/purchase-email.js
//
// Confirmation email (via SES) after a booker successfully buys email OR SMS
// credits. Called from the idempotent fulfilment functions right after the
// credits are granted, so it fires exactly once per purchase.
//
// Never throws — a failed email must not break fulfilment.

import { adminDb } from "../../firebase-admin.js";
import { sendViaSES } from "../mail/ses-client.js";
import { generateSenderEmail } from "./sender.js";
import { renderTransactionalEmail, renderReceiptTable, escapeHtml } from "../mail/transactional-layout.js";
import { timeOfDay, formatLongDate } from "../mail/email-brand.js";

const naira = (n) =>
  `₦${Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function bookerUrl() {
  return process.env.BOOKER_APP_URL || "https://booker.spotix.com.ng";
}

async function lookupEventName(eventId) {
  if (!eventId) return null;
  try {
    const snap = await adminDb.collection("events").doc(eventId).get();
    return snap.exists ? snap.data()?.eventName || null : null;
  } catch {
    return null;
  }
}

/**
 * @param {Object} p
 * @param {"email"|"sms"} p.kind
 * @param {string} p.to
 * @param {string} [p.name]
 * @param {string} p.reference
 * @param {number} p.creditAmount
 * @param {string} [p.eventId]       email credits only (they belong to an event)
 * @param {Object} p.rows            { price, fee, total, discountAmount?, discountPercent?, unitPrice? }
 * @param {string} p.paidAt          ISO date
 */
export async function sendCreditPurchaseConfirmationEmail(p) {
  try {
    if (!p.to) {
      console.warn(`[purchase-email] no recipient for ${p.reference}; skipped`);
      return false;
    }

    const isSms = p.kind === "sms";
    const label = isSms ? "SMS" : "email";
    const eventName = isSms ? null : await lookupEventName(p.eventId);
    const who = p.name ? ` ${escapeHtml(p.name)}` : "";

    const rows = [
      [isSms ? "SMS credits" : "Email credits", Number(p.creditAmount).toLocaleString("en-NG")],
    ];
    if (isSms && p.rows.unitPrice) rows.push(["Price per SMS", naira(p.rows.unitPrice)]);
    rows.push([isSms ? "Credit price" : "Package price", naira(p.rows.price)]);
    if (Number(p.rows.discountAmount) > 0) {
      rows.push([`Discount${p.rows.discountPercent ? ` (${p.rows.discountPercent}%)` : ""}`, `-${naira(p.rows.discountAmount)}`, { negative: true }]);
    }
    rows.push(["VAT", naira(p.rows.fee)]);
    rows.push(["Total paid", naira(p.rows.total), { bold: true }]);
    rows.push(["Reference", p.reference]);
    rows.push(["Date", formatLongDate(p.paidAt)]);

    const html = renderTransactionalEmail({
      heading: `Your ${label} credits are ready`,
      bodyHtml: `<p style="margin:0 0 12px;">Good ${timeOfDay()}${who},</p>
        <p style="margin:0 0 12px;">Thanks for your purchase. Your order for <strong>${Number(p.creditAmount).toLocaleString("en-NG")} ${label} credits</strong> have been added${
          eventName ? ` to <strong>${escapeHtml(eventName)}</strong>` : " to your account"
        }.</p>
        ${renderReceiptTable(rows)}
        <p style="margin:0;color:#6b7280;font-size:13px;">Keep this email as your receipt.</p>`,
      ctaLabel: isSms ? "Create a bulk SMS" : "Go to campaigns",
      ctaUrl: `${bookerUrl()}/campaign`,
    });

    await sendViaSES({
      from: `Spotix Booker <${generateSenderEmail()}>`,
      to: p.to,
      subject: `Receipt: ${Number(p.creditAmount).toLocaleString("en-NG")} ${label} credits added`,
      html,
    });
    return true;
  } catch (err) {
    console.error(`[purchase-email] failed for ${p.reference}:`, err?.message || err);
    return false;
  }
}
