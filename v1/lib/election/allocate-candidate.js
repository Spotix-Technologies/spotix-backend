// v1/lib/election/allocate-candidate.js
//
// Step 4 of election-form crediting: attach the candidate to
// election_candidates in Supabase, now that payment has cleared. This is
// the paid-office counterpart to spotix-vote's
// lib/election/register.ts#registerFreeCandidate (free offices insert
// directly, no webhook involved) — same table, same shape, same
// `sp-cand-` id format, just triggered from here instead.
//
// Supabase — not Firestore — is the system of record for election data
// (see spotix-booker/app/lib/election-db.ts and spotix-vote's
// lib/election/db.ts), so unlike allocate-vote.js this step talks to
// supabaseAdmin, not adminDb.

import { supabaseAdmin } from "../supabase-admin.js";
import { claimOfficeSeat, releaseOfficeSeat } from "./seats.js";

function genCandidateId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "sp-cand-";
  for (let i = 0; i < 10; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} refData   — the Reference/{reference} doc data (election_form_purchase shape)
 * @param {string} reference
 * @returns {Promise<{ candidateId: string, alreadyExisted: boolean }>}
 */
export async function allocateCandidate(fastify, refData, reference) {
  const candidateId = genCandidateId();

  // Seats are only ever spent HERE, at the moment a paid candidate is
  // actually credited — this webhook firing IS "on purchase" for the
  // paid path (the pre-checks in spotix-vote's ref/route.ts and
  // resume/route.ts are a courtesy that stops most people from even
  // starting checkout for a full office, but this atomic claim is the
  // real enforcement). If the RPC itself errors out (not "no seats left",
  // an actual failure), never let that block crediting someone who
  // already paid — same reasoning as the amount-mismatch check below;
  // just log it loudly so it gets noticed.
  const seatClaimed = await claimOfficeSeat(refData.officeId).catch((err) => {
    fastify.log.error(`[election] Seat claim RPC failed for office ${refData.officeId} on ${reference}:`, err);
    return true;
  });
  if (!seatClaimed) {
    fastify.log.warn(
      `[election] Office ${refData.officeId} had no seats left when crediting ${reference} — candidate already paid, crediting anyway.`
    );
  }

  const { data, error } = await supabaseAdmin
    .from("election_candidates")
    .insert({
      id: candidateId,
      election_id: refData.electionId,
      office_id: refData.officeId,
      full_name: refData.fullName ?? "",
      email: refData.email ?? "",
      phone: refData.phone ?? "",
      photo_url: refData.photoUrl ?? "",
      answers: refData.answers ?? {},
      bio_data_path: refData.bioDataPath || null,
      form_reference: reference,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation — this office/email pair already has a
    // candidate row. Shouldn't happen in practice (the credit lock in
    // reference.js already stops two concurrent callers from reaching
    // here for the SAME reference), but a candidate could in theory have
    // two different paid references for the same office (e.g. paid,
    // abandoned, paid again under a fresh reference some other way) — in
    // that case the office is already filled for them, so this is a
    // successful no-op rather than an error worth failing the webhook over.
    // No NEW candidate got created on either error path below, so give
    // back any seat we just claimed rather than leaving the office
    // permanently one short.
    if (seatClaimed) await releaseOfficeSeat(refData.officeId);

    if (error.code === "23505") {
      fastify.log.warn(`[election] Candidate already exists for office/email on ${reference} — treating as already credited`);
      const { data: existing } = await supabaseAdmin
        .from("election_candidates")
        .select("id")
        .eq("office_id", refData.officeId)
        .ilike("email", refData.email ?? "")
        .maybeSingle();
      return { candidateId: existing?.id ?? null, alreadyExisted: true };
    }
    throw new Error(`Supabase insert failed: ${error.message}`);
  }

  fastify.log.info(`[election] Candidate ${data.id} attached to office ${refData.officeId} for ${reference}`);
  return { candidateId: data.id, alreadyExisted: false };
}
