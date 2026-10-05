// v1/lib/sms/pricing.js
//
// Bulk SMS pricing. Unlike email (fixed packages), SMS credits are bought as
// any quantity at or above an MOQ, billed per number sent, with volume
// thresholds that lower the per-SMS price.
//
// Config lives in Firestore next to the email packages (managed from
// spotix-admin → Campaigns → Pricing → Bulk SMS):
//   admin/global/smsPricing/config   { basePrice, moq, tiers: [{ minQty, price }] }
//   admin/global/smsDiscounts/{id}   { code, percent, active, expiresAt? }
//
// Price rules (all money rounded to kobo):
//   unit price  = the tier with the highest minQty <= quantity, else basePrice
//                 (the WHOLE order is priced at that unit price)
//   subtotal    = unit price × quantity
//   discount    = subtotal × percent  — reduces the credit price ONLY
//   VAT         = Paystack fee on the pre-discount subtotal — never discounted
//   total       = (subtotal − discount) + VAT
//
// Example: 100 credits @ ₦4.50 → subtotal 450.00, VAT 6.75, total 456.75.
// With a 10% code: discount 45.00 → 405.00 + the same 6.75 VAT = 411.75.

import { adminDb } from "../../firebase-admin.js";
import { calculatePaystackFee } from "../mcp/pricing-math.js";

const CONFIG_REF = adminDb.collection("admin").doc("global").collection("smsPricing").doc("config");
const DISCOUNTS_REF = adminDb.collection("admin").doc("global").collection("smsDiscounts");

export const MAX_PURCHASE_QUANTITY = 1_000_000;

export class SmsNotConfiguredError extends Error {}
export class SmsInvalidQuantityError extends Error {
  constructor(message, code = "invalid_quantity", extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}
export class SmsInvalidDiscountError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid_discount";
  }
}

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Reads + sanitises the pricing config. Never throws on malformed data. */
export async function getSmsPricingConfig() {
  const snap = await CONFIG_REF.get();
  const data = snap.exists ? snap.data() || {} : {};

  const basePrice = Number(data.basePrice);
  const moqRaw = Math.floor(Number(data.moq));
  const tiers = (Array.isArray(data.tiers) ? data.tiers : [])
    .map((t) => ({ minQty: Math.floor(Number(t?.minQty)), price: Number(t?.price) }))
    .filter((t) => Number.isFinite(t.minQty) && t.minQty > 0 && Number.isFinite(t.price) && t.price > 0)
    .sort((a, b) => a.minQty - b.minQty);

  return {
    configured: Number.isFinite(basePrice) && basePrice > 0,
    basePrice: Number.isFinite(basePrice) && basePrice > 0 ? basePrice : 0,
    moq: Number.isFinite(moqRaw) && moqRaw >= 1 ? moqRaw : 1,
    tiers,
  };
}

export function unitPriceFor(config, quantity) {
  let unit = config.basePrice;
  for (const tier of config.tiers) {
    if (quantity >= tier.minQty) unit = tier.price;
  }
  return unit;
}

/** Looks up a discount code. Returns null when no code was given. */
export async function resolveDiscount(code) {
  const clean = String(code ?? "").trim().toUpperCase();
  if (!clean) return null;

  const snap = await DISCOUNTS_REF.where("code", "==", clean).limit(1).get();
  if (snap.empty) throw new SmsInvalidDiscountError("That discount code isn't valid");

  const doc = snap.docs[0];
  const d = doc.data();
  if (d.active === false) throw new SmsInvalidDiscountError("That discount code is no longer active");

  if (d.expiresAt) {
    const expires = typeof d.expiresAt?.toDate === "function" ? d.expiresAt.toDate() : new Date(d.expiresAt);
    if (!Number.isNaN(expires.getTime()) && expires.getTime() < Date.now()) {
      throw new SmsInvalidDiscountError("That discount code has expired");
    }
  }

  const percent = Number(d.percent);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new SmsInvalidDiscountError("That discount code isn't valid");
  }
  return { id: doc.id, code: clean, percent };
}

/**
 * Pure maths — config + quantity + (already-resolved) discount in, a full
 * price breakdown out. All money fields are in naira, rounded to kobo.
 */
export function computeSmsQuote(config, quantity, discount = null) {
  if (!config.configured) throw new SmsNotConfiguredError("Bulk SMS pricing isn't configured yet");
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new SmsInvalidQuantityError("Enter a whole number of credits");
  }
  if (quantity > MAX_PURCHASE_QUANTITY) {
    throw new SmsInvalidQuantityError(`You can buy at most ${MAX_PURCHASE_QUANTITY.toLocaleString("en-NG")} credits at a time`, "above_max");
  }
  if (quantity < config.moq) {
    throw new SmsInvalidQuantityError(
      `The minimum order is ${config.moq.toLocaleString("en-NG")} credits`, "below_moq", { moq: config.moq }
    );
  }

  const unitPrice = unitPriceFor(config, quantity);
  const subtotal = round2(unitPrice * quantity);
  const discountPercent = discount ? discount.percent : 0;
  const discountAmount = round2((subtotal * discountPercent) / 100);
  const discountedSubtotal = round2(subtotal - discountAmount);
  // VAT is Paystack's fee on the full (pre-discount) credit price. The
  // discount deliberately never touches it.
  const vat = round2(calculatePaystackFee(subtotal));
  const total = round2(discountedSubtotal + vat);

  return {
    quantity,
    unitPrice,
    basePrice: config.basePrice,
    subtotal,
    discountCode: discount ? discount.code : null,
    discountPercent,
    discountAmount,
    discountedSubtotal,
    vat,
    total,
  };
}

/** Convenience: read config, resolve the code, compute. */
export async function quoteSmsPurchase(quantity, discountCode) {
  const config = await getSmsPricingConfig();
  const discount = await resolveDiscount(discountCode);
  return computeSmsQuote(config, Number(quantity), discount);
}
