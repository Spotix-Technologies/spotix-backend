// v1/lib/mail/email-brand.js
//
// Shared brand tokens for hand-built HTML transactional emails. Pulled out
// of ticket-confirmation-template.js so any future raw-HTML email (vote
// confirmations, election confirmations, etc.) can reuse the same palette
// instead of re-declaring hex values inline.

export const BRAND = {
  ink: "#3d2c5e", // primary text / headings
  purple: "#6b2fa5", // primary brand purple
  purpleLight: "#9b59d6",
  purpleSoft: "#faf5ff", // panel background
  purpleBorder: "#e9d5ff",
  purpleDivider: "#f3e8ff",
  muted: "#6b7280",
  mutedLight: "#9ca3af",
  bodyText: "#4a5566",
  pageBg: "#f0eaf8",
  white: "#ffffff",
};

export const BRAND_GRADIENT = `linear-gradient(135deg, ${BRAND.purple} 0%, ${BRAND.purpleLight} 100%)`;

export const COMPANY = {
  name: "Spotix",
  addressLine1: "1, Emeka Akigwe Crescent, Near Nnamdi Azikiwe University",
  addressLine2: "Ifite-Awka, Awka, Anambra, Nigeria",
  supportEmail: "support@spotix.com.ng",
  siteUrl: "https://spotix.com.ng",
  // Hosted Spotix logo used in every email header (absolute URL — email
  // clients can't resolve relative paths). Override with EMAIL_LOGO_URL.
  logoUrl:
    process.env.EMAIL_LOGO_URL ||
    "https://pr8izwkmfk.ufs.sh/f/YKd7r5s4rfRjXcwoqGNxlg9HyU4Wi3Xb0OQwGuI865Srz7qm",
};

/**
 * The branded header row shared by the transactional emails: the "Spotix"
 * wordmark on the left and the logo on the right, inside the purple band —
 * the same layout AWS uses for its notification emails. The logo sits on a
 * white circular badge so it stays visible whatever colours the artwork has.
 * Table-row markup — drop it inside the card's outer <table>.
 */
export function renderEmailHeader() {
  const name = escapeFooterHtml(COMPANY.name);
  return `<tr><td style="background:${BRAND.purple};padding:16px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td align="left" valign="middle" style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;">${name}</td>
        <td align="right" valign="middle" width="48">
          <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
            <td align="center" valign="middle" style="width:44px;height:44px;background:#ffffff;border-radius:22px;">
              <img src="${escapeFooterHtml(COMPANY.logoUrl)}" alt="${name}" width="32" height="32" style="display:block;margin:0 auto;width:32px;height:32px;border:0;outline:none;text-decoration:none;" />
            </td>
          </tr></table>
        </td>
      </tr>
    </table>
  </td></tr>`;
}

// ─── Footer + small helpers shared by the booker-facing transactional emails
// (credit purchase confirmations, bulk SMS approved/rejected). Everything
// here is computed at SEND time, so the footer year is always the current one.

const WAT = "Africa/Lagos";

function escapeFooterHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Current year in Nigerian time (so the footer rolls over at WAT midnight). */
export function currentYear(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-NG", { timeZone: WAT, year: "numeric" }).format(now));
}

/** "morning" | "afternoon" | "evening" — in Nigerian time. */
export function timeOfDay(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: WAT, hour: "2-digit", hour12: false }).format(now)
  ) % 24;
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/** "4 October 2026" — in Nigerian time. */
export function formatLongDate(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: WAT, day: "numeric", month: "long", year: "numeric" }).format(d);
}

/**
 * The shared email footer (table-row markup — drop it inside the card's
 * outer <table>). Brand tokens + company details come from this file, and
 * the copyright year is the current year at the moment of sending.
 */
export function renderEmailFooter(now = new Date()) {
  const year = currentYear(now);
  return `<tr><td style="padding:20px 28px;border-top:1px solid ${BRAND.purpleDivider};background:${BRAND.purpleSoft};text-align:center;font-family:Arial,Helvetica,sans-serif;">
    <p style="margin:0 0 6px;color:${BRAND.muted};font-size:12px;line-height:1.5;">
      Need help? <a href="mailto:${escapeFooterHtml(COMPANY.supportEmail)}" style="color:${BRAND.purple};text-decoration:none;">${escapeFooterHtml(COMPANY.supportEmail)}</a>
      &nbsp;·&nbsp; <a href="${escapeFooterHtml(COMPANY.siteUrl)}" style="color:${BRAND.purple};text-decoration:none;">spotix.com.ng</a>
    </p>
    <p style="margin:0 0 6px;color:${BRAND.mutedLight};font-size:12px;line-height:1.5;">
      ${escapeFooterHtml(COMPANY.addressLine1)}, ${escapeFooterHtml(COMPANY.addressLine2)}
    </p>
    <p style="margin:0;color:${BRAND.mutedLight};font-size:12px;">&copy; ${year} ${escapeFooterHtml(COMPANY.name)}. All rights reserved.</p>
  </td></tr>`;
}
