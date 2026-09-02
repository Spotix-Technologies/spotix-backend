import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): drop in the real Mailjet Template ID once the "Booker
// verification rejected" template (v1/emails/booker-verification-rejected.html)
// is published — left blank on purpose, same pattern as
// booker-verification-approved.js.
const BOOKER_VERIFICATION_REJECTED_TEMPLATE_ID = 8319677

// Display labels for the three document types a verification request can
// have. Kept in sync with DOC_META in spotix-admin's verification-client.tsx
// and spotix-booker's app/verification/page.tsx.
const DOCUMENT_LABELS = {
  nin: "National ID (NIN)",
  selfie: "Selfie",
  proofOfAddress: "Proof of Address",
}

/**
 * Route: Booker verification document rejected
 *
 * Fired by spotix-admin's POST /api/v1/verification/[verificationId]/reject
 * right after a single document on a verification request has been marked
 * rejected — this only ever concerns one document at a time, the other two
 * (if uploaded) are untouched.
 *
 * This route never resolves anything itself — spotix-admin already knows
 * who the booker is, which document was rejected, and what the admin wrote
 * as the problem/suggestion, so it just hands over display-ready values.
 */
export default async function bookerVerificationRejectedRoute(fastify, options) {
  fastify.post("/booker-verification-rejected", async (request, reply) => {
    try {
      const { email, name, document, problem, suggestion } = request.body

      if (!email || !document || !problem) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for booker verification rejection notification",
        })
      }

      const verificationUrl = `${process.env.BOOKER_APP_URL || "https://booker.spotix.com.ng"}/verification`

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "verification@spotix.com.ng", Name: "Spotix Verification" },
            To: [{ Email: email, Name: name || "Booker" }],
            TemplateID: BOOKER_VERIFICATION_REJECTED_TEMPLATE_ID,
            TemplateLanguage: true,
            Subject: `Action needed: ${DOCUMENT_LABELS[document] || document} couldn't be approved`,
            Variables: {
              year: new Date().getFullYear().toString(),
              recipient_name: name || "there",
              document_label: DOCUMENT_LABELS[document] || document,
              problem,
              suggestion: suggestion || "Please re-upload a clearer copy of this document.",
              verification_url: verificationUrl,
            },
          },
        ],
      })

      console.log(`Booker verification rejection email sent to ${email} for document ${document}`)

      return {
        success: true,
        message: "Booker verification rejection notification sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending booker verification rejection notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send booker verification rejection notification",
        error: error.message,
      })
    }
  })
}
