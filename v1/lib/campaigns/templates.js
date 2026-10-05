/**
 * v1/lib/campaigns/templates.js
 *
 * The 3 production templates (spec §26). Each is conservative,
 * table-based, inline-styled HTML for email-client compatibility (§54).
 * They only ever render server-supplied data — the organizer's message
 * arrives as plain text (never HTML), so there's no way to inject
 * markup through it (spec §26's "don't let the frontend submit
 * arbitrary complete HTML").
 *
 * Preview mockups for the picker UI live in spotix-booker's
 * public/campaign-templates/*.html (static, illustrative only — the
 * real render always happens here).
 *
 * formatMessage/escapeHtml now live in ./rich-text.js (bold/italic/
 * underline/links/lists/alignment, not just bold) — re-exported below
 * so existing importers of "./templates.js" keep working unchanged.
 */

import { escapeHtml, formatMessage } from "./rich-text.js";

const DEFAULT_CTA = "View Event";

const TEMPLATE_IDS = ["classic", "bold", "minimal"];

function renderClassic({ eventName, message, color, eventUrl, unsubscribeUrl, footer, ctaText }) {
  return `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
    <tr><td style="background:${color};padding:24px 32px;">
      <span style="color:#ffffff;font-size:20px;font-weight:bold;">${escapeHtml(eventName)}</span>
    </td></tr>
    <tr><td style="padding:32px;color:#2d2d2d;font-size:15px;line-height:1.6;">
      ${message}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;">
        <tr><td style="background:${color};border-radius:8px;">
          <a href="${eventUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-weight:bold;text-decoration:none;font-size:15px;">${escapeHtml(ctaText || DEFAULT_CTA)}</a>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:20px 32px;border-top:1px solid #eee;color:#888;font-size:12px;">${footer}</td></tr>
  </table>`;
}

function renderBold({ eventName, message, color, eventUrl, unsubscribeUrl, footer, ctaText }) {
  return `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#111111;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
    <tr><td style="padding:40px 32px 16px;text-align:center;">
      <span style="color:${color};font-size:13px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">${escapeHtml(eventName)}</span>
    </td></tr>
    <tr><td style="padding:0 32px 32px;color:#f2f2f2;font-size:16px;line-height:1.7;text-align:center;">
      ${message}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 0;">
        <tr><td style="background:${color};border-radius:999px;">
          <a href="${eventUrl}" style="display:inline-block;padding:14px 36px;color:#111111;font-weight:bold;text-decoration:none;font-size:15px;">${escapeHtml(ctaText || DEFAULT_CTA)}</a>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:20px 32px;border-top:1px solid #333;color:#999;font-size:12px;text-align:center;">${footer}</td></tr>
  </table>`;
}

function renderMinimal({ eventName, message, color, eventUrl, unsubscribeUrl, footer, ctaText }) {
  return `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;font-family:Georgia,'Times New Roman',serif;">
    <tr><td style="padding:36px 8px 4px;border-bottom:2px solid ${color};">
      <span style="color:#1a1a1a;font-size:18px;">${escapeHtml(eventName)}</span>
    </td></tr>
    <tr><td style="padding:28px 8px;color:#333;font-size:16px;line-height:1.7;">
      ${message}
      <p style="margin-top:24px;">
        <a href="${eventUrl}" style="color:${color};font-weight:bold;text-decoration:underline;font-size:15px;">${escapeHtml(ctaText || DEFAULT_CTA)} →</a>
      </p>
    </td></tr>
    <tr><td style="padding:16px 8px;border-top:1px solid #eee;color:#999;font-size:11px;">${footer}</td></tr>
  </table>`;
}

const RENDERERS = { classic: renderClassic, bold: renderBold, minimal: renderMinimal };

export function isValidTemplateId(templateId) {
  return TEMPLATE_IDS.includes(templateId);
}

export function renderTemplateBody(templateId, params) {
  const renderer = RENDERERS[templateId] || RENDERERS.classic;
  return renderer(params);
}

export { TEMPLATE_IDS, formatMessage, escapeHtml };
