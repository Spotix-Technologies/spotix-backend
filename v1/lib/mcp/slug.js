// v1/lib/mcp/slug.js
//
// Plain-JS port of spotix-booker's app/lib/slug.ts — kept in sync
// deliberately (same "conscious duplication" precedent as
// v1/lib/mcp/pricing-math.js and sale-window.js) so a slug the MCP's
// share_event tool creates on a booker's behalf follows EXACTLY the same
// rules as one they'd create by hand from the Event Link tab, and so the
// two never disagree on what's valid.

const MIN_LENGTH = 3;
const MAX_LENGTH = 60;

export function slugify(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LENGTH);
}

export function isValidSlug(slug) {
  if (!slug) return false;
  if (slug.length < MIN_LENGTH || slug.length > MAX_LENGTH) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

export const SLUG_RULES_HINT = "3–60 characters, lowercase letters, numbers, and hyphens only";

export function withSuffix(base, attempt) {
  if (attempt <= 1) return base;
  const suffix = `-${attempt}`;
  const trimmedBase = base.slice(0, MAX_LENGTH - suffix.length);
  return `${trimmedBase}${suffix}`;
}
