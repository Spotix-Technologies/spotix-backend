// v1/lib/numerox.js
//
// Server-side Numerox client for spotix-backend. Track-only — the
// backend never reads funnel stats back, it only reports the two
// payment-lifecycle outcomes (PAYMENT_SUCCESS / PAYMENT_FAILED) that
// only it knows about, from webhook.js. No authorizer, no meaningful
// maxDaysFetch — nothing here ever calls numerox.stats.
//
// Requires the `numerox` package as a local/workspace dependency (it's
// not published to a registry) — `"numerox": "file:../numerox"` in
// package.json, sitting alongside this repo. `firebase-admin` is
// already a dependency here (see ./firebase-admin.js).

import { createNumeroxClient } from "@drexx-codes/numerox";
import { FirestoreNumeroxStore } from "@drexx-codes/numerox/firestore";
import { adminDb } from "../utils/firebase.js";

export const numerox = createNumeroxClient({
  store: new FirestoreNumeroxStore({ db: adminDb }),
  appName: "spotix-backend",
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
  logger: {
    debug: () => {},
    info: () => {},
    warn: (message, meta) => console.warn(`[numerox] ${message}`, meta ?? ""),
    error: (message, meta) => console.error(`[numerox] ${message}`, meta ?? ""),
  },
});
