// v1/lib/affiliate/withdraw.js
//
// Affiliate withdrawals. Called only by spotix-affiliates' server (internal
// secret). Everything that decides money is computed HERE — the caller only
// says who/what/which bank account, never how much.
//
// The money ledger lives in SUPABASE (see spotix-affiliates/supabase/
// affiliates-schema.sql), same as booker payouts:
//   affiliate_withdrawals      one row per payout attempt, keyed by reference
//   affiliate_wallet_credits   referral bonuses (referral wallet = credits - withdrawals)
// Firestore is only READ here (affiliate profile, event, link, payout method,
// admin switches). Paystack's transfer.* webhooks settle rows by reference.
//
// Two kinds of withdrawal, both always "in full":
//   - "event":    ticketsSold x the rate locked on the event when the
//                 affiliate was linked. Only 24h AFTER the event has ended.
//   - "referral": the whole referral wallet balance (computed in SQL).

import crypto from "crypto";
import { adminDb } from "../../utils/firebase.js";
import { supabaseAdmin } from "../supabase-admin.js";
import { getWithdrawableAtMs } from "./event-time.js";

export class WithdrawError extends Error {
  constructor(message, status = 400, code = "BAD_REQUEST", extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function isAffiliateWithdrawalReference(reference) {
  return typeof reference === "string" && reference.startsWith("SPTX-AFFW-");
}

function newReference() {
  return `SPTX-AFFW-${crypto.randomBytes(9).toString("hex").toUpperCase()}`;
}

async function paystack(path, init) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) throw new Error(data?.message || `Paystack request failed (${res.status})`);
  return data;
}

async function assertPayoutsAllowed(affiliate) {
  const settings = (await adminDb.collection("admin").doc("affiliateSettings").get()).data() || {};
  if (settings.payoutsEnabled === false) {
    throw new WithdrawError("Affiliate withdrawals are temporarily disabled.", 403, "PAYOUTS_DISABLED");
  }
  if (affiliate.payoutsDisabled === true) {
    throw new WithdrawError("Withdrawals are disabled for your account. Please contact Spotix support.", 403, "AFFILIATE_PAYOUTS_DISABLED");
  }
}

/** Works out what an event withdrawal is worth and checks every rule. Firestore reads only. */
async function priceEventWithdrawal(code, eventId) {
  const [linkSnap, eventSnap] = await Promise.all([
    adminDb.collection("Affiliates").doc(code).collection("affiliatedEvents").doc(eventId).get(),
    adminDb.collection("events").doc(eventId).get(),
  ]);
  if (!linkSnap.exists || !eventSnap.exists) throw new WithdrawError("You are not affiliated with this event.", 403, "FORBIDDEN");
  const ev = eventSnap.data();
  if (ev.affiliateId !== code) throw new WithdrawError("You are no longer the affiliate for this event.", 403, "FORBIDDEN");
  if (ev.suspended === true) throw new WithdrawError("This event is currently under review. Please contact Spotix support.", 403, "EVENT_SUSPENDED");

  const unlockAt = getWithdrawableAtMs(ev);
  if (unlockAt === null) throw new WithdrawError("This event's end time could not be determined.", 400, "BAD_EVENT_TIME");
  if (Date.now() < unlockAt) throw new WithdrawError("You can withdraw 24 hours after the event has ended.", 403, "NOT_YET", { unlockAt });

  const rate = Number(ev.affiliateRate ?? linkSnap.data().rate ?? 0);
  const ticketsSold = Number(ev.ticketsSold) || 0;
  const amount = round2(ticketsSold * rate);
  if (amount <= 0) throw new WithdrawError("There is nothing to withdraw for this event.", 400, "NOTHING_TO_WITHDRAW");
  return { eventName: ev.eventName ?? "", ticketsSold, rate, amount };
}

/** Marks a withdrawal failed. Only acts while it's still "processing" (idempotent). */
export async function failWithdrawal(reference, reason, paystackStatus) {
  const { error } = await supabaseAdmin
    .from("affiliate_withdrawals")
    .update({ status: "failed", failure_reason: reason ?? "Transfer failed", paystack_status: paystackStatus ?? null, resolved_at: new Date().toISOString() })
    .eq("reference", reference)
    .eq("status", "processing");
  if (error) throw error;
}

/** Marks a withdrawal successful. Only acts while it's still "processing" (idempotent). */
export async function succeedWithdrawal(reference) {
  const { error } = await supabaseAdmin
    .from("affiliate_withdrawals")
    .update({ status: "successful", paystack_status: "success", resolved_at: new Date().toISOString() })
    .eq("reference", reference)
    .eq("status", "processing");
  if (error) throw error;
}

export async function processAffiliateTransferEvents(fastify, events) {
  for (const { event, data } of events) {
    const reference = data?.reference;
    if (!reference) continue;
    try {
      if (event === "transfer.success") await succeedWithdrawal(reference);
      else await failWithdrawal(reference, data?.reason || data?.gateway_response || "Transfer failed or was reversed", event === "transfer.reversed" ? "reversed" : "failed");
      fastify.log.info(`[affiliate] ${event} applied to ${reference}`);
    } catch (err) {
      fastify.log.error({ err }, `[affiliate] Failed to apply ${event} to ${reference}`);
    }
  }
}

export async function withdraw(fastify, { affiliateCode, uid, kind, eventId, methodId }) {
  if (!affiliateCode || !uid || !methodId) throw new WithdrawError("affiliateCode, uid and methodId are required.");
  if (kind !== "event" && kind !== "referral") throw new WithdrawError("kind must be 'event' or 'referral'.");
  if (kind === "event" && !eventId) throw new WithdrawError("eventId is required for event withdrawals.");

  const affSnap = await adminDb.collection("affiliateProfiles").doc(affiliateCode).get();
  if (!affSnap.exists) throw new WithdrawError("Affiliate not found.", 404, "NOT_FOUND");
  if (affSnap.data().uid !== uid) throw new WithdrawError("This affiliate account does not belong to you.", 403, "FORBIDDEN");
  await assertPayoutsAllowed(affSnap.data());

  const methodRef = adminDb.collection("payoutMethods").doc(uid).collection("methods").doc(methodId);
  const methodSnap = await methodRef.get();
  if (!methodSnap.exists) throw new WithdrawError("Payout method not found.", 404, "NOT_FOUND");
  const method = methodSnap.data();

  const priced = kind === "event" ? await priceEventWithdrawal(affiliateCode, eventId) : null;
  const reference = newReference();

  // Atomic reservation in Postgres. The unique index / advisory lock inside
  // the function make double-withdrawals impossible.
  const { data: claimed, error: claimErr } = await supabaseAdmin.rpc("affiliate_claim_withdrawal", {
    p_reference: reference,
    p_code: affiliateCode,
    p_user_id: uid,
    p_kind: kind,
    p_event_id: kind === "event" ? eventId : null,
    p_event_name: priced?.eventName ?? null,
    p_tickets_sold: priced?.ticketsSold ?? null,
    p_rate: priced?.rate ?? null,
    p_amount: priced?.amount ?? null,
    p_bank_name: method.bankName,
    p_bank_code: method.bankCode,
    p_account_number: method.accountNumber,
    p_account_name: method.accountName,
    p_method_id: methodId,
  });
  if (claimErr) {
    if (claimErr.code === "23505") throw new WithdrawError("This event has already been withdrawn.", 409, "ALREADY_WITHDRAWN");
    if (String(claimErr.message).includes("NOTHING_TO_WITHDRAW")) throw new WithdrawError("There is nothing to withdraw.", 400, "NOTHING_TO_WITHDRAW");
    fastify.log.error({ err: claimErr }, "[affiliate] claim failed");
    throw new WithdrawError("Couldn't start the withdrawal. Please try again.", 500, "CLAIM_FAILED");
  }
  const amount = Number(claimed.amount);

  try {
    const bal = await paystack("/balance");
    const ngn = (bal.data ?? []).find((b) => b.currency === "NGN");
    if ((ngn ? ngn.balance / 100 : 0) < amount) {
      throw new Error("Payouts can't be processed right now. Please try again shortly.");
    }

    let recipientCode = method.recipientCode;
    if (!recipientCode) {
      const rec = await paystack("/transferrecipient", {
        method: "POST",
        body: JSON.stringify({ type: "nuban", name: method.accountName, account_number: method.accountNumber, bank_code: method.bankCode, currency: "NGN" }),
      });
      recipientCode = rec.data.recipient_code;
      methodRef.update({ recipientCode }).catch(() => {});
    }

    const transfer = await paystack("/transfer", {
      method: "POST",
      body: JSON.stringify({
        source: "balance",
        amount: Math.round(amount * 100),
        recipient: recipientCode,
        reference,
        reason: kind === "referral" ? "Spotix affiliate referral earnings" : "Spotix affiliate event earnings",
      }),
    });

    const pStatus = transfer.data?.status ?? null;
    await supabaseAdmin
      .from("affiliate_withdrawals")
      .update({ transfer_code: transfer.data?.transfer_code ?? null, paystack_status: pStatus })
      .eq("reference", reference);
    if (pStatus === "otp") {
      fastify.log.error(`[affiliate] ${reference} is waiting for OTP approval on Paystack. Turn OFF transfer confirmation in Paystack Settings → Preferences.`);
    }
    fastify.log.info(`[affiliate] ${reference} initiated for ${affiliateCode} (${kind}) ₦${amount}`);
    return { reference, amount, status: "processing" };
  } catch (err) {
    fastify.log.error({ err }, `[affiliate] Transfer initiation failed for ${reference}`);
    await failWithdrawal(reference, err.message || "Failed to initiate transfer", "initiation_failed").catch(() => {});
    throw new WithdrawError(err.message || "Failed to initiate transfer.", 502, "TRANSFER_FAILED");
  }
}

/**
 * Asks Paystack for the real status of a transfer and settles the ledger row.
 * Safety net for when the transfer.* webhook is late, lost, or not configured.
 */
export async function reconcileWithdrawal(fastify, reference) {
  if (!isAffiliateWithdrawalReference(reference)) throw new WithdrawError("Bad reference.", 400);
  const { data: row, error } = await supabaseAdmin.from("affiliate_withdrawals").select("status").eq("reference", reference).maybeSingle();
  if (error) throw new WithdrawError("Lookup failed.", 500, "INTERNAL");
  if (!row) throw new WithdrawError("Withdrawal not found.", 404, "NOT_FOUND");
  if (row.status !== "processing") return { status: row.status };

  let verified;
  try {
    verified = await paystack(`/transfer/verify/${encodeURIComponent(reference)}`);
  } catch (err) {
    if (/not found/i.test(err.message)) {
      await failWithdrawal(reference, "Transfer was never created", "not_found");
      return { status: "failed", paystackStatus: "not_found" };
    }
    throw new WithdrawError(err.message, 502, "PAYSTACK");
  }

  const pStatus = verified.data?.status;
  if (pStatus === "success") {
    await succeedWithdrawal(reference);
    return { status: "successful", paystackStatus: pStatus };
  }
  if (pStatus === "failed" || pStatus === "reversed") {
    await failWithdrawal(reference, verified.data?.reason || `Transfer ${pStatus}`, pStatus);
    return { status: "failed", paystackStatus: pStatus };
  }
  await supabaseAdmin.from("affiliate_withdrawals").update({ paystack_status: pStatus ?? null }).eq("reference", reference);
  if (pStatus === "otp") fastify.log.warn(`[affiliate] ${reference} still waiting for OTP approval on Paystack`);
  return { status: "processing", paystackStatus: pStatus };
}
