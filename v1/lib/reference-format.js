// v1/lib/reference-format.js
//
// Canonical shape validators for the two payment reference keys used
// across Spotix: ticket/booking references and voting references.
//
// Both are minted client-side as {prefix}-{timestampMs}-{2 random letters}
// — the letter suffix (added on top of the millisecond timestamp) is what
// rules out same-millisecond collisions under concurrent checkout traffic:
//
//   SPTX-REF-{timestampMs}-{AA}   e.g. SPTX-REF-1754643200123-QK
//   sptx-vt-{timestampMs}-{aa}    e.g. sptx-vt-1754643200123-qk
//
// References minted before this change won't carry the suffix
// (SPTX-REF-{timestampMs} / sptx-vt-{timestampMs}) — both shapes are
// accepted everywhere so historical / in-flight references keep working.
// Nothing anywhere in the backend parses a timestamp back out of the
// reference string, so the extra suffix segment is safe to append.

const TICKET_REF_RE = /^SPTX-REF-\d+(-[A-Za-z]{2})?$/;
const VOTE_REF_RE = /^sptx-vt-\d+(-[A-Za-z]{2})?$/;

/** True if `reference` matches the ticket/booking reference shape. */
export function isValidTicketReference(reference) {
  return typeof reference === "string" && TICKET_REF_RE.test(reference);
}

/** True if `reference` matches the voting-purchase reference shape. */
export function isValidVoteReference(reference) {
  return typeof reference === "string" && VOTE_REF_RE.test(reference);
}

/** True if `reference` matches either known reference shape. */
export function isValidReference(reference) {
  return isValidTicketReference(reference) || isValidVoteReference(reference);
}
