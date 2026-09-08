// v1/lib/mcp/reference.js
//
// Plain-JS port of spotix-user/src/app/lib/reference-id.ts's
// buildTicketReference — so orders created via the MCP (v1/mcp/orders.js)
// mint a reference in the EXACT same shape (SPTX-REF-{timestamp}-{AA})
// that spotix-backend's own reference-format.js validator, webhook.js,
// and the ticket-generation pipeline already expect. No new reference
// shape is introduced for MCP-originated orders.

import crypto from "crypto";

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomLetters(length = 2) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHA[crypto.randomInt(0, ALPHA.length)];
  }
  return out;
}

/** Builds a ticket/booking payment reference: SPTX-REF-{timestamp}-{AA} */
export function buildTicketReference(timestamp = Date.now()) {
  return `SPTX-REF-${timestamp}-${randomLetters(2)}`;
}
