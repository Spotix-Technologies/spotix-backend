import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): same pattern as election-form-confirmation.js — drop in
// the real Mailjet Template ID once "Election form — pay later"
// (v1/emails/election-form-pay-later.html) is published. Left at 0 on
// purpose; the route no-ops (and logs) instead of sending a broken email.
const ELECTION_FORM_PAY_LATER_TEMPLATE_ID = 8295554

/**
 * Route: Election candidate form — pay later reminder
 *
 * Fired by spotix-vote's /api/v1/election/ref route the moment a
 * candidate picks "Pay later" instead of paying immediately — the
 * Reference doc already exists (status "pending") by the time this
 * fires, this is purely the reminder email with the resume link, never
 * blocking on it (see that route's fire-and-forget fetch).
 */
export default async function electionFormPayLaterRoute(fastify, options) {
  fastify.post("/election-form-pay-later", async (request, reply) => {
    try {
      const { email, recipientName, electionName, officeName, reference, totalAmount, resumeUrl } = request.body

      if (!email || !officeName || !electionName || !reference || !resumeUrl) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for election form pay-later email",
        })
      }

      if (!ELECTION_FORM_PAY_LATER_TEMPLATE_ID) {
        fastify.log.warn(
          `[election-form-pay-later] ELECTION_FORM_PAY_LATER_TEMPLATE_ID not set yet — skipping send for ${reference} (reference is still saved; this only affects the reminder email)`
        )
        return { success: true, message: "Template not configured yet — email skipped" }
      }

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "elections@spotix.com.ng", Name: "Spotix Elections" },
            To: [{ Email: email, Name: recipientName || "Candidate" }],
            TemplateID: ELECTION_FORM_PAY_LATER_TEMPLATE_ID,
            TemplateLanguage: true,
            Subject: `Your ${officeName} form is saved — pay whenever you're ready`,
            Variables: {
              year: new Date().getFullYear().toString(),
              recipient_name: recipientName || "there",
              office_name: officeName,
              election_name: electionName,
              reference,
              total_amount: String(totalAmount ?? 0),
              resume_url: resumeUrl,
            },
          },
        ],
      })

      console.log(`Election pay-later reminder sent to ${email} for reference ${reference}`)

      return {
        success: true,
        message: "Election form pay-later email sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending election form pay-later email:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send election form pay-later email",
        error: error.message,
      })
    }
  })
}
