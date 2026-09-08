// v1/lib/queue/token.js
//
// Anonymous identity for the virtual queue. Buyers never log in to join
// a queue, so the "who is this" the rest of the system relies on is a
// signed, opaque token (HMAC'd, carries eventId + a random jti) rather
// than a userId — this same token string is the member used in the
// Redis sorted sets in sweep.js.

import crypto from "crypto";

function getSecret() {
  const secret = process.env.QUEUE_TOKEN_SECRET;
  if (!secret) throw new Error("QUEUE_TOKEN_SECRET environment variable is required");
  return secret;
}

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  let expectedSig;
  try {
    expectedSig = crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
  } catch {
    return null;
  }

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
