// v1/lib/voting/vote-confirmation-email.js
//
// Step 6 of vote crediting: send the buyer a "your vote is in" receipt
// email via the backend's own /v1/notify/vote-purchase-confirmation route.
// Mirrors v1/lib/ticket/confirmation-email.js — self-fetch, non-blocking,
// only ever called after the vote has actually been credited (never on
// the error path in processVotingCharge, so a buyer never gets a receipt
// for a vote that didn't land).

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} params
 * @param {object} params.refData     — the Reference/{reference} doc data
 * @param {string} params.reference
 */
export async function sendVoteConfirmationEmail(fastify, { refData, reference }) {
  const recipientEmail = refData?.payerEmail ?? refData?.guestEmail ?? null;
  if (!recipientEmail) {
    fastify.log.warn(`[voting] No payer email on reference ${reference} — skipping confirmation email`);
    return;
  }

  try {
    const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:2000";
    const APP_URL = process.env.APP_URL || "https://spotix.com.ng";

    // Prefer the moment the payment actually completed (stamped by
    // markReferenceStatus just before crediting) over "now", so a
    // reconciled-late reference still shows the real purchase time.
    const purchaseTimestamp = refData?.paymentCompletedAt ?? refData?.createdAt ?? new Date().toISOString();
    const purchaseDateObj = new Date(purchaseTimestamp);

    const purchaseDate = new Intl.DateTimeFormat("en-NG", {
      timeZone: "Africa/Lagos",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(purchaseDateObj);

    const purchaseTime =
      new Intl.DateTimeFormat("en-NG", {
        timeZone: "Africa/Lagos",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(purchaseDateObj) + " WAT";

    const pollName = refData?.pollName ?? "this poll";
    const pollUrl = `${APP_URL}/polls/${encodeURIComponent(pollName)}`;

    const emailPayload = {
      email: recipientEmail,
      recipientName: refData?.payerName ?? refData?.guestName ?? "there",
      contestantName: refData?.contestantName ?? "-",
      voteCount: refData?.voteCount ?? 0,
      reference,
      pollName,
      pollUrl,
      purchaseDate,
      purchaseTime,
    };

    const emailResponse = await fetch(`${BACKEND_URL}/v1/notify/vote-purchase-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(emailPayload),
    });

    if (emailResponse.ok) {
      fastify.log.info(`[voting] Vote confirmation email sent for ${reference}`);
    } else {
      const responseBody = await emailResponse.text();
      fastify.log.warn(`[voting] Vote confirmation email failed for ${reference} — status: ${emailResponse.status} | body: ${responseBody}`);
    }
  } catch (error) {
    fastify.log.error(`[voting] Vote confirmation email error for ${reference} (non-blocking): ${error.message}`, { stack: error.stack });
  }
}
