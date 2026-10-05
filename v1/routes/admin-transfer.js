/**
 * v1/routes/admin-transfer.js
 *
 * Internal, service-to-service only — called by spotix-admin's Transfers
 * menu (see spotix-admin's app/lib/paystack-admin.ts). Never called from
 * a browser. Protected the same way as v1/routes/payout-process.js: a
 * shared `x-internal-secret: CRON_SECRET` header (see
 * v1/middleware/internal-auth.js), since these are equally "only our own
 * trusted services may hit this" endpoints.
 *
 * Routes:
 *   GET  /v1/admin/wallet-balance
 *   GET  /v1/admin/banks
 *   POST /v1/admin/resolve-account     { accountNumber, bankCode }
 *   GET  /v1/admin/transfer-fee        ?amount=X
 *   GET  /v1/admin/paystack-transfers  ?page=&perPage=
 *   POST /v1/admin/initiate-transfer   { reference, amount, reason,
 *                                         bankCode, accountNumber, accountName,
 *                                         recipientCode?, recipientEmail? }
 *     Terminal resolution (successful/failed) is NOT synchronous — it
 *     arrives later via the transfer.* webhook (see v1/routes/webhook.js
 *     → v1/lib/admin-transfer/events.js).
 *
 * See v1/controllers/admin-transfer.controller.js for the actual handlers.
 */

import { requireInternalSecret } from "../middleware/internal-auth.js";
import {
  getWalletBalanceHandler,
  listBanksHandler,
  resolveAccountHandler,
  transferFeeHandler,
  paystackTransfersHandler,
  initiateTransferHandler,
} from "../controllers/admin-transfer.controller.js";

function guarded(handler) {
  return async (request, reply) => {
    if (requireInternalSecret(request, reply)) return;
    return handler(request, reply);
  };
}

export default async function adminTransferRoute(fastify, options) {
  fastify.get("/admin/wallet-balance", guarded(getWalletBalanceHandler));
  fastify.get("/admin/banks", guarded(listBanksHandler));
  fastify.post("/admin/resolve-account", guarded(resolveAccountHandler));
  fastify.get("/admin/transfer-fee", guarded(transferFeeHandler));
  fastify.get("/admin/paystack-transfers", guarded(paystackTransfersHandler));
  fastify.post("/admin/initiate-transfer", guarded(initiateTransferHandler));
}
