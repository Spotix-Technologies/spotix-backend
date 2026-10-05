// v1/routes/cron/payout.js
//
// GET /v1/cron/process-payouts — batches pending Firestore `payouts` docs
// into a Paystack bulk transfer. Header: x-cron-secret: <CRON_SECRET>
//
// NOT currently registered in server.js (see the note in
// v1/controllers/cron/payout.controller.js) — carried over unregistered
// exactly as found in the original codebase.
//
// Fastify route wiring only — see v1/controllers/cron/payout.controller.js
// for the actual job logic.

import { runPayoutCron } from "../../controllers/cron/payout.controller.js";

export default async function cronPayoutRoute(fastify, options) {
  fastify.get("/cron/process-payouts", runPayoutCron);
}
