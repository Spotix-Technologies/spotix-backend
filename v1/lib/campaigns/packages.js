/**
 * v1/lib/campaigns/packages.js
 *
 * Campaign credit packages live in Firebase, in the SAME admin/global
 * config doc spotix-admin already uses for restrictedDate/restrictedDays
 * (spotix-admin/app/api/v1/admin/global/route.ts) — a new
 * `emailCreditPackages` subcollection alongside those, not a new config
 * mechanism (spec §11).
 *
 * Managed from spotix-admin/app/admin-dashboard/campaigns/pricing —
 * each package is just { credit_amount, price, active }. Analytics are
 * no longer sold as a separate tier: buying any package always includes
 * campaign statistics (see credits.js's grantPurchasedCredits).
 *
 * getActivePackages() is read on every booker campaign-dashboard load,
 * so it's cached for an hour via getOrSetCache (single-flight refresh —
 * see v1/utils/redis-client.js). spotix-admin busts
 * ACTIVE_PACKAGES_CACHE_KEY immediately on any pricing edit (see
 * spotix-admin/app/lib/redis-admin.ts's activePackagesCacheKey()) so
 * changes still show up right away instead of waiting out the TTL.
 */

import { adminDb } from "../../firebase-admin.js";
import { getOrSetCache } from "../../utils/redis-client.js";

const PACKAGES_REF = adminDb.collection("admin").doc("global").collection("emailCreditPackages");

// Keep this in sync with activePackagesCacheKey() in
// spotix-admin/app/lib/redis-admin.ts — same shared Upstash instance.
const ACTIVE_PACKAGES_CACHE_KEY = "campaigns:active-packages";
const ACTIVE_PACKAGES_CACHE_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * A package doc without a numeric `credit_amount` AND `price` can't be
 * sold, and used to crash the booker's Buy Credits modal
 * ("Cannot read properties of undefined (reading 'toLocaleString')").
 * Malformed docs are dropped here (and logged, so the admin can fix or
 * delete them) instead of being cached and shipped to every booker.
 */
function isSellablePackage(pkg) {
  return (
    Number.isFinite(Number(pkg.credit_amount)) && Number(pkg.credit_amount) > 0 &&
    Number.isFinite(Number(pkg.price)) && Number(pkg.price) > 0
  );
}

async function fetchActivePackages() {
  const snap = await PACKAGES_REF.where("active", "==", true).get();
  const all = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const bad = all.filter((pkg) => !isSellablePackage(pkg));
  if (bad.length) {
    console.warn(
      `[campaign-packages] ignoring ${bad.length} malformed active package(s) in admin/global/emailCreditPackages: ${bad.map((b) => b.id).join(", ")}`
    );
  }

  return all
    .filter(isSellablePackage)
    .map((pkg) => ({ ...pkg, credit_amount: Number(pkg.credit_amount), price: Number(pkg.price) }))
    .sort((a, b) => a.credit_amount - b.credit_amount);
}

export async function getActivePackages() {
  return getOrSetCache(ACTIVE_PACKAGES_CACHE_KEY, ACTIVE_PACKAGES_CACHE_TTL_SECONDS, fetchActivePackages);
}

export async function getPackageById(packageId) {
  const doc = await PACKAGES_REF.doc(packageId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}
