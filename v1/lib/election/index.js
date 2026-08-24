// v1/lib/election/index.js
//
// Orchestrates the full election-candidate crediting pipeline out of the
// step modules in this folder, the same way v1/lib/voting/index.js does
// for votes and v1/lib/ticket/index.js does for tickets:
//
//   reference.js                — load Reference/{reference}, idempotency
//                                  guard, stamp payment outcome (steps 1-3)
//   allocate-candidate.js        — insert the candidate into Supabase
//                                  election_candidates (step 4)
//   daily-aggregation.js          — admin/elections/{electionId}/{date},
//                                  feeds spotix-booker's PayoutTab (step 4a)
//   analytics.js                   — admin/analytics daily/monthly/yearly (step 5)
//   candidate-confirmation-email.js — "you're registered" receipt (step 6)
//   wat-date.js                      — shared Africa/Lagos date-part helper
//
// Firestore:
//   Reference/{reference}   ← payment reference (SPTX-ELE-{timestamp}-{AA}),
//                              same collection ticket.js/voting.js use
//   admin/elections/{electionId}/{YYYY-MM-DD} ← daily form-fee aggregation
//   admin/analytics/{daily,monthly,yearly}/{key} ← platform-wide rollup
//
// Supabase (system of record for election data — see
// spotix-booker/app/lib/election-db.ts and spotix-vote's
// lib/election/db.ts, same project, same tables):
//   election_candidates ← the actual candidate row this whole pipeline
//                          exists to create for a PAID office. Free
//                          offices skip this entire module — they're
//                          inserted directly by spotix-vote's
//                          lib/election/register.ts, no payment involved.
//
// Where this differs from voting/ticket crediting: there's no
// "allocation onto a shared counter" step (no FieldValue.increment on a
// vote/ticket count) — a paid election form is a one-time registration,
// not a repeatable purchase, so the whole "credit" is just "does the
// candidate row exist yet". The unique (office_id, email) constraint in
// Supabase is what actually enforces "one form per person per office";
// the Firestore claim lock here exists to keep the daily/analytics
// increments from double-counting on a redelivered webhook, same as it
// does in voting/reference.js.

import { adminDb } from "../../firebase-admin.js";

import {
  loadReference,
  isAlreadyProcessed,
  markReferenceStatus,
  claimCandidateCreditLock,
  finalizeCandidateCredit,
  releaseCandidateCreditLock,
} from "./reference.js";
import { allocateCandidate } from "./allocate-candidate.js";
import { updateDailyElectionForms } from "./daily-aggregation.js";
import { reportElectionAnalytics } from "./analytics.js";
import { sendCandidateConfirmationEmail } from "./candidate-confirmation-email.js";

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {"charge.success"|"charge.failed"} event
 * @param {object} data   — Paystack event data
 * @param {string} reference — SPTX-ELE-{timestampMs}-{AA}
 */
export async function processElectionCharge(fastify, event, data, reference) {
  const paymentStatus = event === "charge.success" ? "successful" : "failed";

  // ── Steps 1-2: load reference + idempotency guard ───────────────────────
  const loaded = await loadReference(fastify, adminDb, reference);
  if (!loaded) return { status: "not_found", reference };
  const { referenceRef, refData } = loaded;

  if (isAlreadyProcessed(refData)) {
    fastify.log.info(`[election] ${reference} candidate already credited — skipped`);
    return { status: "already_processed", reference };
  }

  // ── Step 3: stamp payment outcome onto the reference ─────────────────────
  await markReferenceStatus(fastify, referenceRef, reference, event, data, paymentStatus);

  if (paymentStatus === "failed") {
    return { status: "failed", reference };
  }

  // ── Atomic claim: only ONE concurrent caller may credit this reference ───
  const claim = await claimCandidateCreditLock(adminDb, referenceRef);

  if (claim.claimResult === "already_credited") {
    fastify.log.info(`[election] ${reference} candidate already credited — skipped`);
    return { status: "already_processed", reference };
  }
  if (claim.claimResult === "locked") {
    fastify.log.warn(`[election] ${reference} candidate credit already in progress elsewhere — skipping duplicate`);
    return { status: "processing", reference };
  }

  // claim.claimResult === "claimed" — we hold the lock now, and MUST
  // always resolve it below (finalize on success, release-without-credit
  // on error) so a genuine failure doesn't permanently block a retry.
  const activeRefData = claim.refData ?? refData;

  if (!activeRefData?.electionId || !activeRefData?.officeId) {
    fastify.log.warn(`[election] Missing electionId/officeId on reference ${reference} — skipping allocation`);
    await finalizeCandidateCredit(fastify, referenceRef, reference, null);
    return { status: "successful_no_allocation", reference };
  }

  // Sanity check only — Paystack already charged the right amount (the
  // checkout was opened with the server-computed totalAmount), this just
  // surfaces a loud log if something upstream ever drifts. Never blocks
  // crediting: the buyer already paid, withholding their candidacy over
  // a logging mismatch would be worse than the mismatch itself.
  const expectedKobo = Math.round(Number(activeRefData.totalAmount ?? 0) * 100);
  const paidKobo = Number(data?.amount ?? 0);
  if (expectedKobo && paidKobo && expectedKobo !== paidKobo) {
    fastify.log.warn(`[election] Amount mismatch on ${reference}: expected ₦${expectedKobo / 100}, Paystack charged ₦${paidKobo / 100}`);
  }

  let creditSucceeded = false;
  let candidateId = null;

  try {
    const result = await allocateCandidate(fastify, activeRefData, reference);
    candidateId = result.candidateId;

    // ── Step 4a: daily form-fee aggregation (skip on the "already
    // existed" branch — that means an earlier reference already counted
    // this office/email pair, so counting it again here would double it) ──
    if (!result.alreadyExisted) {
      await updateDailyElectionForms(fastify, adminDb, {
        electionId: activeRefData.electionId,
        electionName: activeRefData.electionName ?? "",
        netAmount: Number(activeRefData.formFee ?? 0),
        reference,
      });
    }

    await finalizeCandidateCredit(fastify, referenceRef, reference, candidateId);
    creditSucceeded = true;
  } catch (err) {
    fastify.log.error(`[election] Candidate allocation failed for ${reference} (will retry on next attempt):`, err);
    await releaseCandidateCreditLock(fastify, referenceRef, reference);
  }

  // ── Step 6: candidate confirmation email ──────────────────────────────
  // Only ever sent once the candidate is actually credited — never on
  // the error path above.
  if (creditSucceeded) {
    await sendCandidateConfirmationEmail(fastify, { refData: activeRefData, reference });
  }

  // ── Step 5: admin analytics ────────────────────────────────────────────
  await reportElectionAnalytics(fastify, adminDb, {
    totalAmount: activeRefData.totalAmount,
    serviceFee: activeRefData.serviceFee,
    reference,
  });

  return { status: creditSucceeded ? "successful" : "processing_failed", reference, candidateId };
}
