import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): drop in the real Mailjet Template ID once the "Election
// form confirmation" template (v1/emails/election-form-confirmation.html)
// is published — left blank on purpose, same pattern as
// vote-purchase-confirmation.js.
const ELECTION_FORM_CONFIRMATION_TEMPLATE_ID = 0

/**
 * Route: Election candidate form confirmation
 *
 * Fired by v1/lib/election/candidate-confirmation-email.js (step 6 of
 * the election-candidate crediting pipeline in v1/lib/election/index.js)
 * right after a paid candidate has actually been credited into
 * election_candidates — never before, so nobody gets a "you're
 * registered" receipt for a form that didn't clear payment.
 *
 * This route never resolves anything itself — the caller already has
 * every display-ready value from the Reference doc, so it just hands
 * them over as Mailjet template variables.
 */
export default async function electionFormConfirmationRoute(fastify, options) {
  fastify.post("/election-form-confirmation", async (request, reply) => {
    try {
      const {
        email,
        recipientName,
        officeName,
        electionName,
        reference,
        electionUrl,
        formFee,
        purchaseDate,
        purchaseTime,
      } = request.body

      if (!email || !officeName || !electionName || !reference) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for election form confirmation",
        })
      }

      if (!ELECTION_FORM_CONFIRMATION_TEMPLATE_ID) {
        fastify.log.warn(
          `[election-form-confirmation] ELECTION_FORM_CONFIRMATION_TEMPLATE_ID not set yet — skipping send for ${reference} (candidate is still credited; this only affects the receipt email)`
        )
        return { success: true, message: "Template not configured yet — email skipped" }
      }

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "elections@spotix.com.ng", Name: "Spotix Elections" },
            To: [{ Email: email, Name: recipientName || "Candidate" }],
            TemplateID: ELECTION_FORM_CONFIRMATION_TEMPLATE_ID,
            TemplateLanguage: true,
            Subject: `You're registered for ${officeName} — ${electionName}`,
            Variables: {
              year: new Date().getFullYear().toString(),
              recipient_name: recipientName || "there",
              office_name: officeName,
              election_name: electionName,
              reference,
              election_url: electionUrl || "https://spotix.com.ng",
              form_fee: String(formFee ?? 0),
              purchase_date: purchaseDate || "-",
              purchase_time: purchaseTime || "-",
            },
          },
        ],
      })

      console.log(`Election form confirmation sent to ${email} for reference ${reference}`)

      return {
        success: true,
        message: "Election form confirmation sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending election form confirmation:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send election form confirmation",
        error: error.message,
      })
    }
  })
}
