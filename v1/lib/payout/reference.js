// v1/lib/payout/reference.js
//
// Canonical shape for payout transaction references, mirroring the
// {prefix}-{timestampMs}-{2 random letters} pattern already used for
// ticket (SPTX-REF-...) and vote (sptx-vt-...) references — see
// v1/lib/reference-format.js.
//
//   SPTX-TRNS-{timestampMs}-{AA}   e.g. SPTX-TRNS-1755100000000-QK
//
// This exact string is used as:
//   1. The primary key (`reference`) of the Supabase `payouts` row.
//   2. The Paystack transfer `reference` sent on the transfer request —
//      Paystack echoes it back verbatim on the transfer.success/failed/
//      reversed webhook, so no timestamp-parsing or AT-suffix stitching
//      is needed to resolve which row a webhook event belongs to (unlike
//      the old cron job's `{payoutId}AT{timestamp}` scheme).
//   3. The value written onto the Firestore date doc
//      (admin/events|votes/{id}/{date}.payoutReference) so the booker UI
//      can show "this day is being paid out under ref X" without a
//      round-trip to Supabase.

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PAYOUT_REF_RE = /^SPTX-TRNS-\d+-[A-Za-z]{2}$/;

function randomLetters(count = 2) {
  let out = "";
  for (let i = 0; i < count; i++) {
    out += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  }
  return out;
}

/** Mints a new, effectively-unique payout reference. */
export function generatePayoutReference() {
  return `SPTX-TRNS-${Date.now()}-${randomLetters(2)}`;
}

/** True if `reference` matches the payout reference shape. */
export function isValidPayoutReference(reference) {
  return typeof reference === "string" && PAYOUT_REF_RE.test(reference);
}
