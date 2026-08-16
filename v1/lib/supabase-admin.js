/**
 * v1/lib/supabase-admin.js
 *
 * Service-role Supabase client — same project spotix-booker's
 * app/lib/supabase.ts talks to, now also used here for the `payouts`
 * table (see /supabase/payout-schema.sql).
 *
 * Never expose this key or client to anything outside this backend
 * service. The browser never talks to Supabase directly for payouts —
 * see v1/payout-stream.js, which relays status updates over SSE instead.
 *
 * Env vars required (same values already provisioned for spotix-booker):
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) env var is required");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var is required");
}

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 10 } },
});
