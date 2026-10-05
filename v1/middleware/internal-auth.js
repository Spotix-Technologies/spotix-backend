/**
 * v1/lib/internal-auth.js
 *
 * Shared "is this call coming from one of our own trusted services"
 * check — the exact same x-internal-secret/CRON_SECRET convention
 * v1/payout-process.js already used, extracted here so v1/admin-transfer.js
 * (and any future internal-only route) can reuse it instead of
 * duplicating the header check inline.
 */

export function requireInternalSecret(request, reply) {
  const secret = request.headers["x-internal-secret"];
  if (!secret || secret !== process.env.CRON_SECRET) {
    reply.code(401).send({ success: false, error: "Unauthorized" });
    return true;
  }
  return false;
}
