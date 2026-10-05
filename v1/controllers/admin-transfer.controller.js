// v1/controllers/admin-transfer.controller.js
//
// Handlers for the internal, service-to-service admin Transfers menu
// (see spotix-admin's app/lib/paystack-admin.ts). Extracted from the old
// v1/admin-transfer.js so the route file (v1/routes/admin-transfer.js) is
// just Fastify wiring. All Paystack calls go through v1/lib/paystack.js —
// this is the only place those wallet/transfer endpoints get called on
// the admin wallet's behalf.

import {
  getWalletBalance,
  listBanks,
  resolveAccount,
  calculateTransferFee,
  createTransferRecipient,
  initiateTransfer,
  listRecentTransfers,
  PaystackError,
} from "../lib/paystack.js";

// Reference prefixes for transfers our own systems initiate. Anything
// from Paystack's /transfer history NOT starting with one of these was
// initiated directly on the Paystack dashboard by someone with wallet
// access, outside our admin Transfers UI or booker/poll payout pipeline.
const OWN_REFERENCE_PREFIXES = ["SPTX-XFER-", "SPTX-TRNS-"];
function isOwnReference(reference) {
  return OWN_REFERENCE_PREFIXES.some((p) => (reference || "").startsWith(p));
}

export async function getWalletBalanceHandler(request, reply) {
  try {
    const balances = await getWalletBalance();
    return reply.code(200).send({ success: true, balances });
  } catch (err) {
    request.log.error({ err }, "[admin-transfer] wallet-balance failed");
    const status = err instanceof PaystackError ? 502 : 500;
    return reply.code(status).send({ success: false, error: err.message || "Failed to fetch wallet balance" });
  }
}

export async function listBanksHandler(request, reply) {
  try {
    const banks = await listBanks();
    return reply.code(200).send({ success: true, banks });
  } catch (err) {
    request.log.error({ err }, "[admin-transfer] banks failed");
    const status = err instanceof PaystackError ? 502 : 500;
    return reply.code(status).send({ success: false, error: err.message || "Failed to fetch banks" });
  }
}

export async function resolveAccountHandler(request, reply) {
  const { accountNumber, bankCode } = request.body || {};
  if (!accountNumber || !bankCode) {
    return reply.code(400).send({ success: false, error: "accountNumber and bankCode are required" });
  }

  try {
    const resolved = await resolveAccount(accountNumber, bankCode);
    return reply.code(200).send({ success: true, ...resolved });
  } catch (err) {
    request.log.error({ err }, "[admin-transfer] resolve-account failed");
    const status = err instanceof PaystackError ? 400 : 500;
    return reply.code(status).send({ success: false, error: err.message || "Could not resolve account" });
  }
}

export async function transferFeeHandler(request, reply) {
  const amount = Number(request.query?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return reply.code(400).send({ success: false, error: "amount must be a positive number" });
  }

  const fee = calculateTransferFee(amount);
  return reply.code(200).send({ success: true, amount, fee, amountAfterFee: amount - fee });
}

// Withdrawals made directly on Paystack (not through our admin Transfers
// UI or the booker/poll payout pipeline) — surfaced in the admin
// Transfers list so admins have full visibility into wallet outflow, not
// just what our own system initiated.
export async function paystackTransfersHandler(request, reply) {
  const page = Math.max(1, Number(request.query?.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(request.query?.perPage) || 20));

  try {
    const { transfers, meta } = await listRecentTransfers({ page, perPage });
    const external = transfers.filter((t) => !isOwnReference(t.reference));
    return reply.code(200).send({ success: true, transfers: external, meta });
  } catch (err) {
    request.log.error({ err }, "[admin-transfer] paystack-transfers failed");
    const status = err instanceof PaystackError ? 502 : 500;
    return reply.code(status).send({ success: false, error: err.message || "Failed to fetch Paystack transfer history" });
  }
}

export async function initiateTransferHandler(request, reply) {
  const { reference, amount, reason, bankCode, accountNumber, accountName, recipientEmail } = request.body || {};
  let { recipientCode } = request.body || {};

  if (!reference || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || !reason) {
    return reply.code(400).send({ success: false, error: "reference, amount, and reason are required" });
  }

  try {
    if (!recipientCode) {
      if (!bankCode || !accountNumber || !accountName) {
        return reply.code(400).send({
          success: false,
          error: "bankCode, accountNumber, and accountName are required to create a recipient",
        });
      }
      // recipientEmail is optional — supplied by the admin Disbursements
      // feature (a team member withdrawing their own payout) so Paystack
      // has the recipient's email on file against the transfer recipient
      // it creates. The booker/admin-transfer flows never pass this.
      const recipient = await createTransferRecipient({ name: accountName, accountNumber, bankCode, email: recipientEmail });
      recipientCode = recipient.recipientCode;
    }

    const result = await initiateTransfer({ amount: Number(amount), recipientCode, reason, reference });

    request.log.info(`[admin-transfer] Transfer initiated for ${reference} — transfer_code: ${result.transferCode}`);
    return reply.code(200).send({ success: true, recipientCode, transferCode: result.transferCode, status: result.status });
  } catch (err) {
    request.log.error({ err }, `[admin-transfer] initiate-transfer failed for ${reference}`);
    const status = err instanceof PaystackError ? 502 : 500;
    return reply.code(status).send({ success: false, error: err.message || "Failed to initiate transfer" });
  }
}
