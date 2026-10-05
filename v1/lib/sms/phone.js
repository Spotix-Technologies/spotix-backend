// v1/lib/sms/phone.js
//
// Server-side twin of spotix-booker/app/lib/sms-phone.ts — the booker UI
// validates as the user types, but the backend never trusts that and runs
// the exact same rules again before anything is written to storage.
//
// Rules:
//   • every stored number is exactly 11 digits (0 + 7/8/9 + 9 digits)
//   • a letter anywhere in a contact is flagged
//   • "+234" is accepted; after it the number can't start with 0 and must
//     start with 7, 8 or 9 (it's stored as the 11-digit local form)

export const MAX_RECIPIENTS = 50000;

/** @returns {{ ok: true, number: string } | { ok: false, reason: string }} */
export function normalizeNigerianNumber(raw) {
  const original = String(raw ?? "").trim();
  if (!original) return { ok: false, reason: "Empty number" };

  // Spreadsheets love spaces, dashes and brackets — those aren't errors.
  const s = original.replace(/[\s\-().]/g, "");
  if (!s) return { ok: false, reason: "Empty number" };

  if (/[A-Za-z]/.test(s)) return { ok: false, reason: "Contains a letter" };

  if (s.startsWith("+")) {
    if (!s.startsWith("+234")) return { ok: false, reason: "Only +234 numbers are supported" };
    const rest = s.slice(4);
    if (!/^\d+$/.test(rest)) return { ok: false, reason: "Contains invalid characters" };
    if (rest.startsWith("0")) return { ok: false, reason: "After +234 the number can't start with 0" };
    if (!/^[789]/.test(rest)) return { ok: false, reason: "After +234 the number must start with 7, 8 or 9" };
    if (rest.length !== 10) return { ok: false, reason: `Must have 10 digits after +234 (has ${rest.length})` };
    return { ok: true, number: `0${rest}` };
  }

  if (!/^\d+$/.test(s)) return { ok: false, reason: "Contains invalid characters" };
  if (s.length !== 11) {
    const hint = s.length === 10 && /^[789]/.test(s) ? " — missing the leading 0?" : "";
    return { ok: false, reason: `Must be 11 digits (has ${s.length})${hint}` };
  }
  if (!/^0[789]/.test(s)) return { ok: false, reason: "Must start with 07, 08 or 09" };
  return { ok: true, number: s };
}

/**
 * Validates + dedupes a list. Returns the clean numbers and every invalid
 * entry with its reason (never silently dropped).
 */
export function validateNumbers(list) {
  const seen = new Set();
  const numbers = [];
  const invalid = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const result = normalizeNigerianNumber(raw);
    if (!result.ok) {
      invalid.push({ value: String(raw ?? ""), reason: result.reason });
      continue;
    }
    if (seen.has(result.number)) continue;
    seen.add(result.number);
    numbers.push(result.number);
  }
  return { numbers, invalid };
}
