// v1/lib/mcp-oauth/store.js
//
// Data layer for the MCP OAuth authorization server. spotix-backend is
// the ONLY writer of these collections — spotix-booker's /mcp/authorize
// page never touches Firestore for this directly, it calls back into
// v1/mcp-oauth.js's POST /authorize (see that file) so there is exactly
// one place these records are created/mutated, same "single authoritative
// source" principle the rest of v1/lib/mcp/ already follows for
// pricing/inventory.
//
// Token shape: opaque, high-entropy random strings (NOT JWTs) — the same
// choice spotix-booker already made for its `spk_live_...` SDK API keys
// (see spotix-booker's app/api/sdk/keys/route.ts): generate 32 random
// bytes, hash with sha256, use the hash as the Firestore document ID.
// sha256 (unsalted) is safe here specifically because these are
// high-entropy machine-generated secrets, not user passwords — the same
// justification the SDK keys route already relies on. This also means a
// lookup is a single doc get() by hash, not a bcrypt compare loop.
//
// Firestore collections:
//   mcpClients/{clientId}            — registered OAuth clients (DCR)
//   mcpAuthCodes/{sha256(code)}      — single-use authorization codes, short TTL
//   mcpAccessTokens/{sha256(token)}  — bearer tokens tool calls present
//   mcpRefreshTokens/{sha256(token)} — long-lived, rotated on every use
//   mcpConnections/{uid}__{clientId} — one doc per (booker, client) pair,
//                                       for the "Connected Apps" list/revoke
//                                       UI — cheap to query by uid without
//                                       scanning every token doc.

import { randomBytes, createHash, randomUUID } from "crypto";
import { adminDb } from "../../utils/firebase.js";
import { FieldValue } from "firebase-admin/firestore";

const AUTH_CODE_TTL_SECONDS = 5 * 60; // 5 minutes — RFC 6749 §4.1.2 recommends short-lived
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_DAYS = 60;
const MAX_REDIRECT_URIS = 10;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(prefix, bytes = 32) {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// ── Clients (Dynamic Client Registration — RFC 7591) ───────────────────────

/**
 * input: { clientName, redirectUris, logoUri?, clientUri?, tokenEndpointAuthMethod? }
 * Returns the stored client record, INCLUDING clientSecret in plaintext
 * exactly once (never stored/returned again) when a confidential client
 * was requested.
 */
export async function registerClient(input) {
  const clientId = randomUUID();
  const isConfidential = input.tokenEndpointAuthMethod === "client_secret_post";
  const clientSecret = isConfidential ? randomToken("mcpcs", 32) : null;

  const record = {
    clientId,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    logoUri: input.logoUri ?? null,
    clientUri: input.clientUri ?? null,
    tokenEndpointAuthMethod: isConfidential ? "client_secret_post" : "none",
    clientSecretHash: clientSecret ? sha256(clientSecret) : null,
    softwareId: input.softwareId ?? null,
    softwareVersion: input.softwareVersion ?? null,
    createdAt: FieldValue.serverTimestamp(),
  };

  await adminDb.collection("mcpClients").doc(clientId).set(record);

  return { ...record, createdAt: undefined, clientSecret: clientSecret ?? undefined };
}

/** Public-safe client lookup — used by both /token (auth check) and
 *  spotix-booker's authorize page (to render "X wants to connect"). */
export async function getClient(clientId) {
  if (!clientId) return null;
  const snap = await adminDb.collection("mcpClients").doc(clientId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

/** True if `redirectUri` exactly matches one the client registered —
 *  never a prefix/substring match (open-redirect prevention, per the
 *  MCP Authorization spec and RFC 6749 §3.1.2.3). */
export function isRegisteredRedirectUri(client, redirectUri) {
  return Array.isArray(client?.redirectUris) && client.redirectUris.includes(redirectUri);
}

export function clientRequiresSecret(client) {
  return client?.tokenEndpointAuthMethod === "client_secret_post";
}

export function verifyClientSecret(client, providedSecret) {
  if (!clientRequiresSecret(client)) return true; // public client — nothing to check, PKCE covers it
  if (!providedSecret) return false;
  return client.clientSecretHash === sha256(providedSecret);
}

export const REDIRECT_URI_LIMIT = MAX_REDIRECT_URIS;

// ── Authorization codes ─────────────────────────────────────────────────────

/**
 * input: { clientId, uid, email, username, redirectUri, scope, codeChallenge, codeChallengeMethod }
 * Returns the raw code (given to spotix-booker to append to the redirect).
 */
export async function createAuthorizationCode(input) {
  const rawCode = randomToken("mcpac", 32);
  const now = new Date();
  await adminDb
    .collection("mcpAuthCodes")
    .doc(sha256(rawCode))
    .set({
      ...input,
      used: false,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: addSeconds(now, AUTH_CODE_TTL_SECONDS),
    });
  return rawCode;
}

/**
 * Single-use redemption: reads, validates, and marks-used in one
 * transaction so two concurrent /token requests for the same code can
 * never both succeed (the MCP Authorization spec calls this out
 * explicitly — code reuse must invalidate the whole grant).
 * Returns the code record on success, or null (already used / not
 * found / expired) — the caller maps null to `invalid_grant`.
 */
export async function redeemAuthorizationCode(rawCode) {
  const ref = adminDb.collection("mcpAuthCodes").doc(sha256(rawCode));
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data();

    if (data.used) {
      // Reuse of a consumed code is a strong signal of interception —
      // proactively revoke every live token this code's grant ever
      // produced. Best-effort, outside the transaction (see caller).
      tx.update(ref, { reusedAt: FieldValue.serverTimestamp() });
      return { ...data, __reused: true };
    }

    const expiresAt = data.expiresAt?.toDate?.() ?? new Date(data.expiresAt);
    if (expiresAt < new Date()) return null;

    tx.update(ref, { used: true, usedAt: FieldValue.serverTimestamp() });
    return data;
  });
}

// ── Access + refresh tokens ─────────────────────────────────────────────────

function connectionDocId(uid, clientId) {
  return `${uid}__${clientId}`;
}

/**
 * Mints a fresh access+refresh token pair, and upserts the human-facing
 * "Connected Apps" record. Used both at initial code exchange and at
 * every refresh-token rotation.
 *
 * input: { clientId, clientName, uid, email, username, scope }
 */
export async function issueTokenPair(input) {
  const { clientId, clientName, uid, email, username, scope } = input;
  const now = new Date();

  const rawAccessToken = randomToken("mcpat", 32);
  const rawRefreshToken = randomToken("mcprt", 32);
  const accessExpiresAt = addSeconds(now, ACCESS_TOKEN_TTL_SECONDS);
  const refreshExpiresAt = addDays(now, REFRESH_TOKEN_TTL_DAYS);

  const batch = adminDb.batch();

  batch.set(adminDb.collection("mcpAccessTokens").doc(sha256(rawAccessToken)), {
    clientId,
    uid,
    email: email ?? null,
    username: username ?? null,
    scope,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: accessExpiresAt,
  });

  batch.set(adminDb.collection("mcpRefreshTokens").doc(sha256(rawRefreshToken)), {
    clientId,
    uid,
    email: email ?? null,
    username: username ?? null,
    scope,
    revoked: false,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: refreshExpiresAt,
  });

  batch.set(
    adminDb.collection("mcpConnections").doc(connectionDocId(uid, clientId)),
    {
      uid,
      clientId,
      clientName: clientName ?? null,
      scope,
      active: true,
      lastUsedAt: FieldValue.serverTimestamp(),
      firstAuthorizedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await batch.commit();

  return {
    accessToken: rawAccessToken,
    refreshToken: rawRefreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope,
  };
}

/**
 * Validates a bearer access token. Returns the resolved identity, or
 * null if invalid/expired/revoked (the connection was pulled). Also
 * refreshes `lastUsedAt` on the connection doc — best-effort, never
 * blocks the auth decision on that write succeeding.
 */
export async function verifyAccessToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string") return null;
  const snap = await adminDb.collection("mcpAccessTokens").doc(sha256(rawToken)).get();
  if (!snap.exists) return null;
  const data = snap.data();

  const expiresAt = data.expiresAt?.toDate?.() ?? new Date(data.expiresAt);
  if (expiresAt < new Date()) return null;

  const connSnap = await adminDb.collection("mcpConnections").doc(connectionDocId(data.uid, data.clientId)).get();
  if (connSnap.exists && connSnap.data().active === false) return null; // revoked by the booker

  connSnap.ref
    ?.set({ lastUsedAt: FieldValue.serverTimestamp() }, { merge: true })
    .catch(() => {});

  return {
    uid: data.uid,
    email: data.email ?? null,
    username: data.username ?? null,
    clientId: data.clientId,
    scope: data.scope,
  };
}

/**
 * Rotates a refresh token: validates it, atomically marks it revoked,
 * and returns the record needed to mint the next pair. Rotation (not
 * reuse) matches spotix-booker's own refresh-token-repo.ts convention —
 * a refresh token is good for exactly one /token call.
 */
export async function consumeRefreshToken(rawToken) {
  const ref = adminDb.collection("mcpRefreshTokens").doc(sha256(rawToken));
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data();

    if (data.revoked) {
      // Reuse of a rotated-away refresh token — likely theft. Kill every
      // live token for this (uid, client) pair as a precaution, same
      // "reuse detection" response spotix-booker's own /api/auth/refresh
      // already applies to its own refresh cookie.
      await revokeConnection(data.uid, data.clientId);
      return { ...data, __reused: true };
    }

    const expiresAt = data.expiresAt?.toDate?.() ?? new Date(data.expiresAt);
    if (expiresAt < new Date()) return null;

    tx.update(ref, { revoked: true, revokedAt: FieldValue.serverTimestamp() });
    return data;
  });
}

// ── Connections ("Connected Apps") ──────────────────────────────────────────

export async function listConnectionsForUser(uid) {
  const snap = await adminDb.collection("mcpConnections").where("uid", "==", uid).where("active", "==", true).get();
  return Promise.all(
    snap.docs.map(async (d) => {
      const data = d.data();
      const client = await getClient(data.clientId);
      return {
        clientId: data.clientId,
        clientName: client?.clientName ?? data.clientName ?? "A custom MCP client",
        logoUri: client?.logoUri ?? null,
        scope: data.scope,
        firstAuthorizedAt: data.firstAuthorizedAt?.toDate?.()?.toISOString() ?? null,
        lastUsedAt: data.lastUsedAt?.toDate?.()?.toISOString() ?? null,
      };
    })
  );
}

/**
 * Revokes a (uid, clientId) connection: flips the connection doc
 * inactive (verifyAccessToken checks this, so live access tokens die
 * immediately without needing to enumerate/delete each one) and revokes
 * every non-revoked refresh token for the pair (so a later /token
 * refresh call also fails outright).
 */
export async function revokeConnection(uid, clientId) {
  const connRef = adminDb.collection("mcpConnections").doc(connectionDocId(uid, clientId));
  await connRef.set({ active: false, revokedAt: FieldValue.serverTimestamp() }, { merge: true });

  const refreshSnap = await adminDb
    .collection("mcpRefreshTokens")
    .where("uid", "==", uid)
    .where("clientId", "==", clientId)
    .where("revoked", "==", false)
    .get();

  if (!refreshSnap.empty) {
    const batch = adminDb.batch();
    refreshSnap.docs.forEach((d) => batch.update(d.ref, { revoked: true, revokedAt: FieldValue.serverTimestamp() }));
    await batch.commit();
  }
}

/** Revokes a single presented token (access or refresh) — RFC 7009. Best
 *  effort at telling which collection it belongs to by trying both. */
export async function revokeToken(rawToken) {
  const hash = sha256(rawToken);

  const atRef = adminDb.collection("mcpAccessTokens").doc(hash);
  const atSnap = await atRef.get();
  if (atSnap.exists) {
    await atRef.delete();
    return true;
  }

  const rtRef = adminDb.collection("mcpRefreshTokens").doc(hash);
  const rtSnap = await rtRef.get();
  if (rtSnap.exists) {
    await rtRef.update({ revoked: true, revokedAt: FieldValue.serverTimestamp() });
    return true;
  }

  return false;
}
