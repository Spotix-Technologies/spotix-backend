// v1/lib/campaigns/paystack-verify.js
//
// Server-side Paystack verification shared by the email-credit and SMS-credit
// purchase flows. The frontend's word is never trusted for what was paid.

/** Raw `data` object from Paystack's verify endpoint, or null when Paystack
 *  doesn't know the reference (e.g. the buyer never reached the payment step). */
export async function verifyWithPaystack(reference) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const json = await res.json().catch(() => ({}));
  return json?.data || null; // { status, amount (kobo), ... }
}

/**
 * "success" | "failed" | "pending".
 *
 * Only an explicit failed/reversed result is final-failed. Anything else
 * (abandoned, ongoing, pending, or Paystack not knowing the reference yet)
 * is still "pending" — the buyer may be mid-payment in their bank app, and
 * marking that "failed" would be wrong (and would show them a scary receipt
 * when they come back to the page).
 */
export function classifyPaystackStatus(data) {
  const status = data?.status;
  if (status === "success") return "success";
  if (status === "failed" || status === "reversed") return "failed";
  return "pending";
}
