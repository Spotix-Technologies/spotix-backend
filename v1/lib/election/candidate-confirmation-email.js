// v1/lib/election/candidate-confirmation-email.js
//
// Step 6 of election-form crediting: send the candidate a "you're
// registered" receipt via this backend's own
// /v1/notify/election-form-confirmation route. Mirrors
// v1/lib/voting/vote-confirmation-email.js — self-fetch, non-blocking,
// only ever called after the candidate has actually been credited
// (never on the error path in processElectionCharge, so nobody gets a
// receipt for a registration that didn't land).

export async function sendCandidateConfirmationEmail(fastify, { refData, reference }) {
  const recipientEmail = refData?.email ?? null;
  if (!recipientEmail) {
    fastify.log.warn(`[election] No email on reference ${reference} — skipping confirmation email`);
    return;
  }

  try {
    const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:2000";
    // NOTE(Drexx): set VOTE_APP_URL in this service's env to the real
    // spotix-vote production URL — no safe default to fall back to here
    // since this backend has no existing reference to it anywhere else.
    const VOTE_APP_URL = process.env.VOTE_APP_URL || process.env.NEXT_PUBLIC_VOTE_APP_URL || "";
    const electionUrl = VOTE_APP_URL ? `${VOTE_APP_URL}/election/${encodeURIComponent(refData.electionId ?? "")}` : "";

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

    const emailPayload = {
      email: recipientEmail,
      recipientName: refData?.fullName ?? "there",
      officeName: refData?.officeName ?? "-",
      electionName: refData?.electionName ?? "this election",
      reference,
      electionUrl,
      formFee: refData?.formFee ?? 0,
      purchaseDate,
      purchaseTime,
    };

    const emailResponse = await fetch(`${BACKEND_URL}/v1/notify/election-form-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(emailPayload),
    });

    if (emailResponse.ok) {
      fastify.log.info(`[election] Candidate confirmation email sent for ${reference}`);
    } else {
      const responseBody = await emailResponse.text();
      fastify.log.warn(`[election] Candidate confirmation email failed for ${reference} — status: ${emailResponse.status} | body: ${responseBody}`);
    }
  } catch (error) {
    fastify.log.error(`[election] Candidate confirmation email error for ${reference} (non-blocking): ${error.message}`, { stack: error.stack });
  }
}
