import { adminDb } from "../firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";

export default async function cronPayoutRoute(fastify, options) {
  fastify.get("/cron/process-payouts", async (request, reply) => {

    // ── 1. Auth ──────────────────────────────────────────────────────────────
    const secret = request.headers["x-cron-secret"];

    if (!secret) {
      fastify.log.warn("[payout job] Unauthorized — no key found in header");
      return reply.code(401).send({ error: "Unauthorized", reason: "No key found in header" });
    }

    if (secret !== process.env.CRON_SECRET) {
      fastify.log.warn("[payout job] Unauthorized — incorrect key in header");
      return reply.code(401).send({ error: "Unauthorized", reason: "Incorrect key in header" });
    }

    fastify.log.info("[payout job] Ping received: scanning pending payouts");

    // ── 2. Fetch pending payouts ─────────────────────────────────────────────
    let pendingSnap;
    try {
      pendingSnap = await adminDb
        .collection("payouts")
        .where("status", "==", "pending")
        .get();
    } catch (err) {
      fastify.log.error({ err }, "[payout job] Database fetch error");
      return reply.code(500).send({ error: "Failed to fetch pending payouts" });
    }

    if (pendingSnap.empty) {
      fastify.log.info("[payout job] No pending payouts found");
      return reply.code(200).send({ success: true, message: "No pending payouts", processed: 0 });
    }

    const pending = pendingSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    fastify.log.info(`[payout job] Found ${pending.length} pending payout(s)`);
    pending.forEach((p, i) => {
      fastify.log.info(
        `[payout job] Payout [${i + 1}] id=${p.id} amount=${p.amount} recipientCode=${p.recipientCode ?? "NULL"} methodId=${p.methodId ?? "NULL"} eventId=${p.eventId} userId=${p.userId}`
      );
    });

    // ── 3. Check Paystack balance ────────────────────────────────────────────
    const totalRequested = pending.reduce((sum, p) => sum + p.amount, 0);
    fastify.log.info(`[payout job] Total requested: ₦${totalRequested}`);

    let paystackBalance = 0;
    try {
      fastify.log.info("[payout job] Fetching Paystack balance...");
      const balanceRes = await fetch("https://api.paystack.co/balance", {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      });
      const balanceData = await balanceRes.json();
      fastify.log.info({ data: balanceData }, "[payout job] Paystack balance response");

      if (!balanceRes.ok || !balanceData.status) {
        fastify.log.error({ data: balanceData }, "[payout job] Paystack balance check failed");
        return reply.code(502).send({ error: "Failed to fetch Paystack balance" });
      }

      const ngnBalance = balanceData.data?.find((b) => b.currency === "NGN");
      paystackBalance = ngnBalance ? ngnBalance.balance / 100 : 0;
      fastify.log.info(`[payout job] Paystack NGN balance: ₦${paystackBalance}`);
    } catch (err) {
      fastify.log.error({ err }, "[payout job] Balance fetch error");
      return reply.code(502).send({ error: "Balance check failed" });
    }

    if (paystackBalance < totalRequested) {
      fastify.log.warn(
        `[payout job] Insufficient balance — have ₦${paystackBalance}, need ₦${totalRequested}`
      );
      return reply.code(200).send({
        success: false,
        message: "Insufficient Paystack balance",
        balance: paystackBalance,
        totalRequested,
      });
    }

    // ── 4. Build transfers, creating recipients where needed ─────────────────
    const BATCH_SIZE = 100;
    const batch = pending.slice(0, BATCH_SIZE);
    const attemptTimestamp = Date.now();
    fastify.log.info(`[payout job] Processing batch of ${batch.length} payout(s) — attempt timestamp: ${attemptTimestamp}`);

    const transfers = [];

    for (const payout of batch) {
      fastify.log.info(`[payout job] Processing payout ${payout.id}...`);
      let recipientCode = payout.recipientCode ?? null;

      if (!recipientCode) {
        fastify.log.info(
          `[payout job] No recipientCode on payout ${payout.id} — creating Paystack recipient`
        );
        try {
          const recipientPayload = {
            type: "nuban",
            name: payout.accountName,
            account_number: payout.accountNumber,
            bank_code: payout.bankCode,
            currency: "NGN",
          };
          fastify.log.info({ data: recipientPayload }, `[payout job] Recipient payload for ${payout.id}`);

          const recipientRes = await fetch("https://api.paystack.co/transferrecipient", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(recipientPayload),
          });

          const recipientData = await recipientRes.json();
          fastify.log.info({ data: recipientData }, `[payout job] Recipient creation response for ${payout.id}`);

          if (!recipientRes.ok || !recipientData.status) {
            fastify.log.error(
              { data: recipientData },
              `[payout job] Failed to create recipient for payout ${payout.id} — skipping`
            );
            continue;
          }

          recipientCode = recipientData.data.recipient_code;

          // Write recipientCode back to payout doc
          try {
            await adminDb.collection("payouts").doc(payout.id).update({ recipientCode });
            fastify.log.info(`[payout job] recipientCode written back to payout doc ${payout.id}`);
          } catch (err) {
            fastify.log.warn({ err }, `[payout job] Failed to write recipientCode to payout doc ${payout.id}`);
          }

          fastify.log.info(`[payout job] Recipient created for payout ${payout.id}: ${recipientCode}`);

          // Write recipientCode back to payoutMethod doc
          if (payout.methodId) {
            try {
              await adminDb
                .collection("payoutMethods")
                .doc(payout.userId)
                .collection("methods")
                .doc(payout.methodId)
                .update({ recipientCode });
              fastify.log.info(`[payout job] recipientCode written back to methodId ${payout.methodId}`);
            } catch (err) {
              fastify.log.warn({ err }, `[payout job] Failed to write recipientCode back to methodId ${payout.methodId}`);
            }
          } else {
            fastify.log.warn(`[payout job] No methodId on payout ${payout.id} — recipientCode not written back`);
          }
        } catch (err) {
          fastify.log.error({ err }, `[payout job] Recipient creation error for payout ${payout.id}`);
          continue;
        }
      } else {
        fastify.log.info(`[payout job] Using existing recipientCode for payout ${payout.id}: ${recipientCode}`);
      }

      // ── Reference: alphanumeric only — no underscores or special characters ──
      const transferReference = `${payout.id}AT${attemptTimestamp}`;

      // ── Entry: only amount, recipient, reference, reason — no currency or metadata ──
      const transferEntry = {
        amount: payout.amount * 100, // kobo
        recipient: recipientCode,
        reference: transferReference,
        reason: `Spotix payout for event ${payout.eventId} on ${payout.date}`,
      };

      fastify.log.info(
        { data: transferEntry },
        `[payout job] Transfer entry for payout ${payout.id} — reference: ${transferReference}`
      );
      transfers.push(transferEntry);
    }

    if (transfers.length === 0) {
      fastify.log.warn("[payout job] No valid transfers after recipient resolution — aborting");
      return reply.code(200).send({ success: false, message: "No valid transfers to process" });
    }

    fastify.log.info({ transfers }, `[payout job] Final transfer payload (${transfers.length} entries)`);

    // ── 5. Send to Paystack bulk transfer ────────────────────────────────────
    // Top-level body: currency, source, transfers only
    let transferResults;
    try {
      fastify.log.info("[payout job] Sending bulk transfer request to Paystack...");
      const transferRes = await fetch("https://api.paystack.co/transfer/bulk", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ currency: "NGN", source: "balance", transfers }),
      });

      const transferData = await transferRes.json();
      fastify.log.info({ data: transferData }, "[payout job] Paystack bulk transfer response");

      if (!transferRes.ok || !transferData.status) {
        fastify.log.error({ data: transferData }, "[payout job] Bulk transfer rejected by Paystack");
        return reply.code(502).send({
          error: "Paystack bulk transfer failed",
          details: transferData.message ?? "Unknown error",
        });
      }

      transferResults = transferData.data;
    } catch (err) {
      fastify.log.error({ err }, "[payout job] Bulk transfer request error");
      return reply.code(502).send({ error: "Bulk transfer request failed" });
    }

    // ── 6. Flip each payout to processing + store transferCode ───────────────
    fastify.log.info(`[payout job] Committing processing status for ${transferResults.length} payout(s)...`);
    const firestoreBatch = adminDb.batch();

    for (let i = 0; i < transferResults.length; i++) {
      const result = transferResults[i];
      const payout = batch[i];
      const ref = adminDb.collection("payouts").doc(payout.id);

      fastify.log.info(
        `[payout job] Marking payout ${payout.id} as processing — transferCode: ${result.transfer_code ?? "NULL"} — reference: ${result.reference ?? "NULL"}`
      );

      firestoreBatch.update(ref, {
        status: "processing",
        transferCode: result.transfer_code ?? null,
        paystackReference: result.reference ?? `${payout.id}AT${attemptTimestamp}`,
        retryCount: FieldValue.increment(1),
        lastAttemptAt: FieldValue.serverTimestamp(),
        processingAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    try {
      await firestoreBatch.commit();
      fastify.log.info("[payout job] Firestore batch committed successfully");
    } catch (err) {
      fastify.log.error({ err }, "[payout job] Firestore batch update error");
      return reply.code(500).send({ error: "Failed to update payout statuses" });
    }

    fastify.log.info(`[payout job] Done — ${transferResults.length} payout(s) queued`);

    return reply.code(200).send({
      success: true,
      message: `${transferResults.length} payout(s) queued for processing`,
      processed: transferResults.length,
      remaining: pending.length - transferResults.length,
    });
  });
}