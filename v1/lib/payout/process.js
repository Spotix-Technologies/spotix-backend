// v1/lib/payout/process.js
//
// processPayoutReference() is the direct replacement for the old
// cron/payout.js batch job — except it acts on exactly ONE reference,
// immediately, the moment booker asks for it (see v1/payout-process.js),
// instead of scanning every "pending" doc on a timer.
//
// Idempotency (the actual bug being fixed): the claim step below is a
// single conditional UPDATE — `SET status='processing' WHERE
// status='initializing'` — executed by Postgres, not a
// read-then-write from Node. Two concurrent calls for the same
// reference (e.g. booker's fire-and-forget call getting retried by a
// flaky network) can both run this function, but only one of them will
// see a row come back from that UPDATE. The loser exits immediately.
// That's the whole idempotency guarantee — no separate lock document,
// no window where both callers believe they "own" the transfer.

import { adminDb } from "../../firebase-admin.js";
import { supabaseAdmin } from "../supabase-admin.js";
import { checkPayoutRateLimit } from "./rate-limit.js";

async function claimForProcessing(reference) {
  const { data, error } = await supabaseAdmin
    .from("payouts")
    .update({ status: "processing", processing_at: new Date().toISOString() })
    .eq("reference", reference)
    .eq("status", "initializing")
    .select()
    .maybeSingle();

  if (error) throw error;
  return data; // null if someone else already claimed it (or it's not "initializing")
}

async function markFailed(reference, reason, createdAt) {
  const durationSeconds = createdAt
    ? Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 1000))
    : 0;

  await supabaseAdmin
    .from("payouts")
    .update({
      status: "failed",
      failure_reason: reason,
      duration_seconds: durationSeconds,
      resolved_at: new Date().toISOString(),
    })
    .eq("reference", reference);
}

async function createRecipient(fastify, payout) {
  const recipientPayload = {
    type: "nuban",
    name: payout.account_name,
    account_number: payout.account_number,
    bank_code: payout.bank_code,
    currency: "NGN",
  };

  const res = await fetch("https://api.paystack.co/transferrecipient", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(recipientPayload),
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data?.message || "Failed to create Paystack transfer recipient");
  }

  const recipientCode = data.data.recipient_code;

  // Best-effort write-back so future payouts from this method skip
  // recipient creation. Never blocks the transfer itself.
  try {
    await supabaseAdmin.from("payouts").update({ recipient_code: recipientCode }).eq("reference", payout.reference);
  } catch (err) {
    fastify.log.warn({ err }, `[payout] Failed to write recipientCode back to Supabase row ${payout.reference}`);
  }

  if (payout.method_id) {
    try {
      await adminDb
        .collection("payoutMethods")
        .doc(payout.user_id)
        .collection("methods")
        .doc(payout.method_id)
        .update({ recipientCode });
    } catch (err) {
      fastify.log.warn({ err }, `[payout] Failed to write recipientCode back to methodId ${payout.method_id}`);
    }
  }

  return recipientCode;
}

/**
 * Processes exactly one payout reference: claims it, rate-limits,
 * resolves/creates the Paystack recipient, and initiates the transfer.
 * Terminal resolution (successful/failed after Paystack accepts the
 * transfer) happens later, from the transfer.* webhook — see
 * v1/payout.js. If Paystack REJECTS the transfer at initiation time
 * (bad recipient, insufficient balance, etc.) this function marks the
 * row failed immediately, since no webhook will ever arrive for a
 * transfer that never started.
 *
 * Returns a small status object for logging/response purposes — callers
 * should treat this as fire-and-forget from the HTTP layer's point of
 * view (see v1/payout-process.js), since the real state machine lives
 * in Supabase + the SSE relay, not in this function's return value.
 */
export async function processPayoutReference(fastify, reference) {
  const claimed = await claimForProcessing(reference);
  if (!claimed) {
    fastify.log.info(`[payout] ${reference} already claimed/resolved — skipping`);
    return { skipped: true };
  }

  fastify.log.info(`[payout] Claimed ${reference} for processing — amount ₦${claimed.amount}`);

  // ── Rate limit (per-user + global) ────────────────────────────────────
  const rl = await checkPayoutRateLimit(fastify, claimed.user_id);
  if (!rl.allowed) {
    fastify.log.warn(`[payout] Rate limited: ${reference} — ${rl.reason}`);
    await markFailed(reference, rl.reason, claimed.created_at);
    return { failed: true, reason: rl.reason };
  }

  // ── Balance check ────────────────────────────────────────────────────
  try {
    const balanceRes = await fetch("https://api.paystack.co/balance", {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const balanceData = await balanceRes.json();
    if (!balanceRes.ok || !balanceData.status) {
      throw new Error("Failed to fetch Paystack balance");
    }
    const ngn = balanceData.data?.find((b) => b.currency === "NGN");
    const available = ngn ? ngn.balance / 100 : 0;
    if (available < claimed.amount) {
      throw new Error("Insufficient balance to process this payout right now. Please try again shortly.");
    }
  } catch (err) {
    fastify.log.error({ err }, `[payout] Balance check failed for ${reference}`);
    await markFailed(reference, err.message || "Balance check failed", claimed.created_at);
    return { failed: true, reason: err.message };
  }

  // ── Recipient (create if needed) ────────────────────────────────────
  let recipientCode = claimed.recipient_code ?? null;
  try {
    if (!recipientCode) {
      recipientCode = await createRecipient(fastify, claimed);
    }
  } catch (err) {
    fastify.log.error({ err }, `[payout] Recipient creation failed for ${reference}`);
    await markFailed(reference, err.message || "Failed to create transfer recipient", claimed.created_at);
    return { failed: true, reason: err.message };
  }

  // ── Initiate transfer ────────────────────────────────────────────────
  try {
    const transferRes = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "balance",
        amount: Math.round(claimed.amount * 100), // kobo
        recipient: recipientCode,
        reference, // SPTX-TRNS-... — Paystack echoes this back on the webhook
        reason: claimed.narration || `Spotix payout — ${reference}`,
      }),
    });

    const transferData = await transferRes.json();
    if (!transferRes.ok || !transferData.status) {
      throw new Error(transferData?.message || "Paystack rejected the transfer");
    }

    await supabaseAdmin
      .from("payouts")
      .update({
        transfer_code: transferData.data?.transfer_code ?? null,
        paystack_reference: transferData.data?.reference ?? reference,
      })
      .eq("reference", reference);

    fastify.log.info(`[payout] Transfer initiated for ${reference} — transfer_code: ${transferData.data?.transfer_code}`);
    return { processing: true };
  } catch (err) {
    fastify.log.error({ err }, `[payout] Transfer initiation failed for ${reference}`);
    await markFailed(reference, err.message || "Failed to initiate transfer", claimed.created_at);
    return { failed: true, reason: err.message };
  }
}
