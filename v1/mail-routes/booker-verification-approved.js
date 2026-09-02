import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): drop in the real Mailjet Template ID once the "Booker
// verification approved" template (v1/emails/booker-verification-approved.html)
// is published — left blank on purpose, same pattern as
// vote-purchase-confirmation.js / team-member-added.js.
const BOOKER_VERIFICATION_APPROVED_TEMPLATE_ID = 8319641

/**
 * Route: Booker verification approved
 *
 * Fired by spotix-admin's POST /api/v1/verification/[verificationId]/verify
 * right after a Booker Verification Tag (BVT) has actually been issued and
 * saved on users/{uid} — never before, so a booker never gets a "you're
 * verified" email for a verification that didn't land.
 *
 * This route never resolves anything itself — spotix-admin already knows
 * who the booker is and what BVT was generated, so it just hands over
 * display-ready values.
 */
export default async function bookerVerificationApprovedRoute(fastify, options) {
  fastify.post("/booker-verification-approved", async (request, reply) => {
    try {
      const { email, name, bvt } = request.body

      if (!email || !bvt) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for booker verification approval notification",
        })
      }

      const dashboardUrl = `${process.env.BOOKER_APP_URL || "https://booker.spotix.com.ng"}`

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "verification@spotix.com.ng", Name: "Spotix Verification" },
            To: [{ Email: email, Name: name || "Booker" }],
            TemplateID: BOOKER_VERIFICATION_APPROVED_TEMPLATE_ID,
            TemplateLanguage: true,
            Subject: "You're verified! Your BVT is ready",
            Variables: {
              year: new Date().getFullYear().toString(),
              recipient_name: name || "there",
              bvt,
              dashboard_url: dashboardUrl,
            },
          },
        ],
      })

      console.log("Booker verification approval email sent successfully to:", email)

      return {
        success: true,
        message: "Booker verification approval notification sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending booker verification approval notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send booker verification approval notification",
        error: error.message,
      })
    }
  })
}
