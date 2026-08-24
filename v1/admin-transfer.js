/**
 * v1/admin-transfer.js
 *
 * Internal, service-to-service only — called by spotix-admin's Transfers
 * menu (see spotix-admin's app/lib/paystack-admin.ts). Never called from
 * a browser. Protected the same way as v1/payout-process.js: a shared
 * `x-internal-secret: CRON_SECRET` header, since these are equally
 * "only our own trusted services may hit this" endpoints.
 *
 * This is the ONLY place Paystack's wallet/transfer endpoints get called
 * on the admin wallet's behalf — spotix-admin holds no Paystack secret
 * key of its own for this feature.
 *
 * Routes:
 *   GET  /v1/admin/wallet-balance
 *   GET  /v1/admin/banks
 *   POST /v1/admin/resolve-account     { accountNumber, bankCode }
 *   GET  /v1/admin/transfer-fee        ?amount=X
 *   POST /v1/admin/initiate-transfer   { reference, amount, reason,
 *                                         bankCode, accountNumber, accountName,
 *                                         recipientCode? }
 *     Creates a Paystack transfer recipient if recipientCode isn't
 *     already known, then initiates the transfer for `amount` (this is
 *     already amount-after-fee — spotix-admin subtracts the fee before
 *     calling this). Returns { recipientCode, transferCode, status }.
 *     Terminal resolution (successful/failed) is NOT synchronous — same
 *     as the existing booker payout pipeline, it arrives later via the
 *     transfer.* webhook (see v1/webhook.js → v1/lib/admin-transfer/events.js),
 *     which is also where analytics get recorded, only on confirmed success.
 */

import { requireInternalSecret } from "./lib/internal-auth.js";
import {
  getWalletBalance,
  listBanks,
  resolveAccount,
  calculateTransferFee,
  createTransferRecipient,
  initiateTransfer,
  listRecentTransfers,
  PaystackError,
} from "./lib/paystack.js";

// Reference prefixes for transfers our own systems initiate. Anything
// from Paystack's /transfer history NOT starting with one of these was
// initiated directly on the Paystack dashboard by someone with wallet
// access, outside our admin Transfers UI or booker/poll payout pipeline.
const OWN_REFERENCE_PREFIXES = ["SPTX-XFER-", "SPTX-TRNS-"];
function isOwnReference(reference) {
  return OWN_REFERENCE_PREFIXES.some((p) => (reference || "").startsWith(p));
}

export default async function adminTransferRoute(fastify, options) {
  fastify.get("/admin/wallet-balance", async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;

    try {
      const balances = await getWalletBalance();
      return reply.code(200).send({ success: true, balances });
    } catch (err) {
      fastify.log.error({ err }, "[admin-transfer] wallet-balance failed");
      const status = err instanceof PaystackError ? 502 : 500;
      return reply.code(status).send({ success: false, error: err.message || "Failed to fetch wallet balance" });
    }
  });

  fastify.get("/admin/banks", async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;

    try {
      const banks = await listBanks();
      return reply.code(200).send({ success: true, banks });
    } catch (err) {
      fastify.log.error({ err }, "[admin-transfer] banks failed");
      const status = err instanceof PaystackError ? 502 : 500;
      return reply.code(status).send({ success: false, error: err.message || "Failed to fetch banks" });
    }
  });

  fastify.post("/admin/resolve-account", async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;

    const { accountNumber, bankCode } = request.body || {};
    if (!accountNumber || !bankCode) {
      return reply.code(400).send({ success: false, error: "accountNumber and bankCode are required" });
    }

    try {
      const resolved = await resolveAccount(accountNumber, bankCode);
      return reply.code(200).send({ success: true, ...resolved });
    } catch (err) {
      fastify.log.error({ err }, "[admin-transfer] resolve-account failed");
      const status = err instanceof PaystackError ? 400 : 500;
      return reply.code(status).send({ success: false, error: err.message || "Could not resolve account" });
    }
  });

  fastify.get("/admin/transfer-fee", async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;

    const amount = Number(request.query?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ success: false, error: "amount must be a positive number" });
    }

    const fee = calculateTransferFee(amount);
    return reply.code(200).send({ success: true, amount, fee, amountAfterFee: amount - fee });
  });

  // Withdrawals made directly on Paystack (not through our admin
  // Transfers UI or the booker/poll payout pipeline) — surfaced in the
  // admin Transfers list so admins have full visibility into wallet
  // outflow, not just what our own system initiated.
  fastify.get("/admin/paystack-transfers", async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;

    const page = Math.max(1, Number(request.query?.page) || 1);
    const perPage = Math.min(50, Math.max(1, Number(request.query?.perPage) || 20));

    try {
      const { transfers, meta } = await listRecentTransfers({ page, perPage });
      const external = transfers.filter((t) => !isOwnReference(t.reference));
      return reply.code(200).send({ success: true, transfers: external, meta });
    } catch (err) {
      fastify.log.error({ err }, "[admin-transfer] paystack-transfers failed");
      const status = err instanceof PaystackError ? 502 : 500;
      return reply.code(status).send({ success: false, error: err.message || "Failed to fetch Paystack transfer history" });
    }
  });

  fastify.post("/admin/initiate-transfer", async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;

    const { reference, amount, reason, bankCode, accountNumber, accountName } = request.body || {};
    let { recipientCode } = request.body || {};

    if (!reference || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || !reason) {
      return reply.code(400).send({ success: false, error: "reference, amount, and reason are required" });
    }

    try {
      if (!recipientCode) {
        if (!bankCode || !accountNumber || !accountName) {
          return reply.code(400).send({ success: false, error: "bankCode, accountNumber, and accountName are required to create a recipient" });
        }
        const recipient = await createTransferRecipient({ name: accountName, accountNumber, bankCode });
        recipientCode = recipient.recipientCode;
      }

      const result = await initiateTransfer({ amount: Number(amount), recipientCode, reason, reference });

      fastify.log.info(`[admin-transfer] Transfer initiated for ${reference} — transfer_code: ${result.transferCode}`);
      return reply.code(200).send({ success: true, recipientCode, transferCode: result.transferCode, status: result.status });
    } catch (err) {
      fastify.log.error({ err }, `[admin-transfer] initiate-transfer failed for ${reference}`);
      const status = err instanceof PaystackError ? 502 : 500;
      return reply.code(status).send({ success: false, error: err.message || "Failed to initiate transfer" });
    }
  });
}
