// v1/lib/election/seats.js
//
// Backend-side counterpart to spotix-vote's lib/election/seats.ts — same
// two Postgres RPC functions (claim_office_seat / release_office_seat,
// see supabase/migrations/*election_seats* in this repo), called from
// allocate-candidate.js at the moment a PAID candidate is actually
// credited (the webhook firing IS "on purchase" for the paid path — see
// index.js's step 4). Kept as its own small file rather than shared with
// spotix-vote since the two repos don't share a module boundary; both
// just call the same underlying RPCs against the same Supabase project.

import { supabaseAdmin } from "../supabase-admin.js";

/** Returns true if a seat was actually claimed, false if the office had none left (or doesn't exist). */
export async function claimOfficeSeat(officeId) {
  const { data, error } = await supabaseAdmin.rpc("claim_office_seat", { p_office_id: officeId });
  if (error) throw new Error(error.message);
  return data !== null;
}

/** Best-effort — see spotix-vote's seats.ts for why this never throws. */
export async function releaseOfficeSeat(officeId) {
  const { error } = await supabaseAdmin.rpc("release_office_seat", { p_office_id: officeId });
  if (error) console.error(`[election] Failed to release seat for office ${officeId}:`, error.message);
}
