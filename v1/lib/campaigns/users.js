/**
 * v1/lib/campaigns/users.js
 *
 * Resolves a booker by email — the admin dashboard identifies people by email,
 * the credit tables key on the Firebase uid (organizer_id).
 */

import { adminDb } from "../../firebase-admin.js";

/** @returns {Promise<null | { uid: string, email: string, username: string|null, fullName: string|null }>} */
export async function findUserByEmail(rawEmail) {
  const email = String(rawEmail || "").trim();
  if (!email) return null;

  const users = adminDb.collection("users");
  // Emails are normally stored lowercase, but try exactly what was typed too.
  const candidates = Array.from(new Set([email.toLowerCase(), email]));
  for (const candidate of candidates) {
    const snap = await users.where("email", "==", candidate).limit(1).get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      const d = doc.data();
      return {
        uid: doc.id,
        email: d.email || candidate,
        username: d.username || null,
        fullName: d.fullName || null,
      };
    }
  }
  return null;
}
