// tests/unit/sms-pricing.test.js
//
// Pure maths for bulk SMS pricing + the phone rules. Firestore is mocked out —
// computeSmsQuote / normalizeNigerianNumber never touch it.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../v1/firebase-admin.js", () => {
  const chain = { doc: () => chain, collection: () => chain, where: () => chain, limit: () => chain, get: async () => ({ exists: false, empty: true, docs: [] }) };
  return { adminDb: chain };
});

const { computeSmsQuote, unitPriceFor, SmsInvalidQuantityError, SmsNotConfiguredError } = await import("../../v1/lib/sms/pricing.js");
const { normalizeNigerianNumber, validateNumbers } = await import("../../v1/lib/sms/phone.js");

const config = {
  configured: true,
  basePrice: 4.5,
  moq: 50,
  tiers: [{ minQty: 200, price: 4 }, { minQty: 500, price: 3.8 }, { minQty: 1000, price: 3.5 }],
};

describe("computeSmsQuote", () => {
  it("matches the worked example: 100 credits at ₦4.50 → ₦450 + ₦6.75 VAT = ₦456.75", () => {
    const q = computeSmsQuote({ ...config, tiers: [] }, 100);
    expect(q.subtotal).toBe(450);
    expect(q.vat).toBe(6.75);
    expect(q.total).toBe(456.75);
  });

  it("a 10% discount reduces the credit price only — VAT stays ₦6.75", () => {
    const q = computeSmsQuote({ ...config, tiers: [] }, 100, { code: "TEN", percent: 10 });
    expect(q.discountAmount).toBe(45);
    expect(q.discountedSubtotal).toBe(405);
    expect(q.vat).toBe(6.75);
    expect(q.total).toBe(411.75);
  });

  it("applies the highest threshold reached to the whole order", () => {
    expect(unitPriceFor(config, 60)).toBe(4.5);
    expect(unitPriceFor(config, 199)).toBe(4.5);
    expect(unitPriceFor(config, 200)).toBe(4);
    expect(unitPriceFor(config, 499)).toBe(4);
    expect(unitPriceFor(config, 500)).toBe(3.8);
    expect(unitPriceFor(config, 5000)).toBe(3.5);
    expect(computeSmsQuote(config, 200).subtotal).toBe(800);
  });

  it("charges VAT (Paystack fee) on the pre-discount price", () => {
    const withCode = computeSmsQuote(config, 1000, { code: "X", percent: 50 });
    const without = computeSmsQuote(config, 1000);
    expect(withCode.vat).toBe(without.vat);
  });

  it("rejects quantities below the MOQ", () => {
    expect(() => computeSmsQuote(config, 49)).toThrow(SmsInvalidQuantityError);
    expect(() => computeSmsQuote(config, 50)).not.toThrow();
  });

  it("rejects fractional / non-positive quantities", () => {
    expect(() => computeSmsQuote(config, 10.5)).toThrow(SmsInvalidQuantityError);
    expect(() => computeSmsQuote(config, 0)).toThrow(SmsInvalidQuantityError);
    expect(() => computeSmsQuote(config, NaN)).toThrow(SmsInvalidQuantityError);
  });

  it("refuses to quote when pricing isn't configured", () => {
    expect(() => computeSmsQuote({ configured: false, basePrice: 0, moq: 1, tiers: [] }, 100)).toThrow(SmsNotConfiguredError);
  });

  it("always rounds money to kobo", () => {
    const q = computeSmsQuote({ ...config, basePrice: 3.333, tiers: [] }, 77);
    for (const v of [q.subtotal, q.vat, q.total, q.discountAmount]) {
      expect(Math.round(v * 100)).toBeCloseTo(v * 100, 6);
    }
  });
});

describe("normalizeNigerianNumber", () => {
  it("accepts 11-digit local numbers", () => {
    expect(normalizeNigerianNumber("08012345678")).toEqual({ ok: true, number: "08012345678" });
    expect(normalizeNigerianNumber("07012345678").ok).toBe(true);
    expect(normalizeNigerianNumber("09012345678").ok).toBe(true);
  });

  it("accepts +234 followed by 7/8/9 and converts to local form", () => {
    expect(normalizeNigerianNumber("+2348012345678")).toEqual({ ok: true, number: "08012345678" });
    expect(normalizeNigerianNumber("+234 701 234 5678")).toEqual({ ok: true, number: "07012345678" });
  });

  it("rejects a 0 right after +234", () => {
    expect(normalizeNigerianNumber("+23408012345678").ok).toBe(false);
  });

  it("rejects +234 not followed by 7/8/9", () => {
    expect(normalizeNigerianNumber("+2346012345678").ok).toBe(false);
  });

  it("flags letters", () => {
    const r = normalizeNigerianNumber("0801234567a");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/letter/i);
  });

  it("rejects wrong lengths", () => {
    expect(normalizeNigerianNumber("0801234567").ok).toBe(false);
    expect(normalizeNigerianNumber("080123456789").ok).toBe(false);
    expect(normalizeNigerianNumber("8012345678").reason).toMatch(/leading 0/);
  });

  it("tolerates spaces, dashes and brackets", () => {
    expect(normalizeNigerianNumber("0801-234-5678").ok).toBe(true);
    expect(normalizeNigerianNumber("(0801) 234 5678").ok).toBe(true);
  });
});

describe("validateNumbers", () => {
  it("dedupes across local and +234 forms and reports invalid entries", () => {
    const { numbers, invalid } = validateNumbers(["08012345678", "+2348012345678", "0801234567a", "123"]);
    expect(numbers).toEqual(["08012345678"]);
    expect(invalid.map((i) => i.value)).toEqual(["0801234567a", "123"]);
  });
});
