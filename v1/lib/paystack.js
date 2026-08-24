/**
 * v1/lib/paystack.js
 *
 * Shared Paystack helpers for the admin Transfers feature (see
 * v1/admin-transfer.js). This is the ONLY place in the codebase that
 * should call Paystack's /balance, /transferrecipient, /transfer,
 * /bank, and /bank/resolve endpoints on the admin wallet's behalf —
 * spotix-admin no longer calls Paystack directly for any of this; it
 * calls the internal-secret-protected routes in v1/admin-transfer.js,
 * which use these helpers.
 *
 * (v1/lib/payout/process.js — the existing booker/poll organizer payout
 * pipeline — has its own inline Paystack calls for transfer recipients
 * and transfers, left untouched here to avoid any risk of regressing a
 * working production flow. If you'd like that consolidated onto this
 * same module too, say so and it's a small follow-up.)
 */

const PAYSTACK_BASE = "https://api.paystack.co";

class PaystackError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function paystackFetch(path, init) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    throw new PaystackError(data.message || `Paystack request failed (${res.status})`, res.status);
  }
  return data;
}

export async function getWalletBalance() {
  const data = await paystackFetch("/balance");
  return (data.data ?? []).map((b) => ({ currency: b.currency, balance: b.balance / 100 }));
}

export async function listBanks() {
  const data = await paystackFetch("/bank?country=nigeria&use_cursor=false&perPage=100");
  const banks = (data.data ?? []).map((b) => ({ name: b.name, code: b.code }));

  // Paystack's bank list can include duplicate entries sharing the same
  // `code` (e.g. a bank listed once per product type — NUBAN, mobile
  // money, etc). Dedupe by code so consumers never get repeated keys.
  const seen = new Set();
  return banks.filter((b) => {
    if (seen.has(b.code)) return false;
    seen.add(b.code);
    return true;
  });
}

export async function resolveAccount(accountNumber, bankCode) {
  const data = await paystackFetch(`/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
  return { accountName: data.data.account_name };
}

/**
 * Fee schedule for Nigerian NIP transfers, per Paystack's published rates
 * at the time this was written. Paystack doesn't expose a "quote the fee"
 * endpoint for transfers (unlike card transactions), so this is a local
 * calculation — double check against Paystack's current pricing page if
 * their bands ever change: https://paystack.com/pricing
 */
export function calculateTransferFee(amount) {
  if (amount <= 5_000) return 10;
  if (amount <= 50_000) return 25;
  return 50;
}

/**
 * Lists transfers straight from Paystack's own /transfer history (NOT
 * our admin_transfers Supabase table). Used to surface withdrawals that
 * were initiated directly on the Paystack dashboard rather than through
 * our admin Transfers UI — see v1/admin-transfer.js's
 * GET /admin/paystack-transfers, which filters this down to only the
 * externally-initiated ones by reference prefix.
 */
export async function listRecentTransfers({ page = 1, perPage = 20 } = {}) {
  const data = await paystackFetch(`/transfer?perPage=${perPage}&page=${page}`);
  const transfers = (data.data ?? []).map((t) => ({
    reference: t.reference,
    amount: (t.amount ?? 0) / 100,
    status: t.status,
    createdAt: t.createdAt ?? t.created_at ?? null,
    beneficiaryName: t.recipient?.name ?? t.recipient?.details?.account_name ?? null,
    bankName: t.recipient?.details?.bank_name ?? null,
    accountNumber: t.recipient?.details?.account_number ?? null,
  }));
  return { transfers, meta: data.meta ?? null };
}

export async function createTransferRecipient({ name, accountNumber, bankCode }) {
  const data = await paystackFetch("/transferrecipient", {
    method: "POST",
    body: JSON.stringify({
      type: "nuban",
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    }),
  });
  return { recipientCode: data.data.recipient_code };
}

export async function initiateTransfer({ amount, recipientCode, reason, reference }) {
  const data = await paystackFetch("/transfer", {
    method: "POST",
    body: JSON.stringify({
      source: "balance",
      amount: Math.round(amount * 100), // naira → kobo
      recipient: recipientCode,
      reason,
      reference,
    }),
  });
  return { transferCode: data.data.transfer_code, status: data.data.status };
}

export { PaystackError };
