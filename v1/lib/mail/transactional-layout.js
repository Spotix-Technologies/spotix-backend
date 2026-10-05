// v1/lib/mail/transactional-layout.js
//
// One card layout for the booker-facing transactional emails (credit purchase
// confirmations, bulk SMS approved / rejected). Palette + footer come from
// email-brand.js, so the footer (with the current year) is built in one place.

import { BRAND, renderEmailHeader, renderEmailFooter } from "./email-brand.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {Object} p
 * @param {string} p.heading    plain text (escaped here)
 * @param {string} p.bodyHtml   trusted/pre-escaped HTML for the body
 * @param {string} [p.ctaLabel]
 * @param {string} [p.ctaUrl]
 */
export function renderTransactionalEmail({ heading, bodyHtml, ctaLabel, ctaUrl }) {
  const cta = ctaLabel && ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;"><tr><td style="background:${BRAND.purple};border-radius:8px;">
        <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 26px;color:#ffffff;font-weight:bold;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
      </td></tr></table>`
    : "";

  return `<!doctype html><html><body style="margin:0;padding:0;background:${BRAND.pageBg};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.pageBg};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${BRAND.white};border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
        ${renderEmailHeader()}
        <tr><td style="padding:28px;color:${BRAND.bodyText};font-size:15px;line-height:1.6;">
          <h2 style="margin:0 0 14px;color:${BRAND.ink};font-size:20px;">${escapeHtml(heading)}</h2>
          ${bodyHtml}
          ${cta}
        </td></tr>
        ${renderEmailFooter()}
      </table>
    </td></tr>
  </table></body></html>`;
}

/** A small two-column "label / value" receipt table. rows: [label, value, {bold?, negative?}] */
export function renderReceiptTable(rows) {
  const tr = rows.map(([label, value, opts = {}]) => `<tr>
      <td style="padding:7px 0;color:${BRAND.muted};font-size:14px;${opts.bold ? "border-top:1px solid " + BRAND.purpleDivider + ";" : ""}">${escapeHtml(label)}</td>
      <td align="right" style="padding:7px 0;color:${opts.negative ? "#15803d" : BRAND.ink};font-size:14px;${opts.bold ? "font-weight:bold;border-top:1px solid " + BRAND.purpleDivider + ";" : ""}">${escapeHtml(value)}</td>
    </tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;background:${BRAND.purpleSoft};border:1px solid ${BRAND.purpleBorder};border-radius:10px;padding:6px 16px;display:table;">${tr}</table>`;
}
