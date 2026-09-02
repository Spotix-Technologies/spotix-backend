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
};
