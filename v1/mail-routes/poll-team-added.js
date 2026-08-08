import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): drop in the real Mailjet Template ID once the "Poll team
// added" template is published — left blank on purpose, same pattern as
// team-member-added.js / vault-notify.js.
const POLL_TEAM_ADDED_TEMPLATE_ID = 8257048

/**
 * Route: Poll team member added
 *
 * Fired by spotix-booker's POST /api/polls/team right after a
 * pollCollaborations doc is created. Mirrors mail-routes/team-member-added.js
 * (the event-team equivalent) but for polls: a poll team member can edit
 * the poll, view vote stats/entries, and adjust poll settings, but can
 * never initiate a payout — only the poll creator can, so the email is
 * explicit about that instead of listing a role label like the event-team
 * email does (poll teams have exactly one access tier, no built-in/custom
 * role split).
 *
 * This route never resolves anything itself — spotix-booker already knows
 * who the poll creator is and who the recipient is, so it just hands over
 * display-ready values.
 */
export default async function pollTeamAddedRoute(fastify, options) {
  fastify.post("/poll-team-added", async (request, reply) => {
    try {
      const { pollId, pollName, adderName, recipientName, email } = request.body

      if (!pollId || !pollName || !adderName || !recipientName || !email) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for poll team notification",
        })
      }

      const pollUrl = `${process.env.BOOKER_APP_URL || "https://booker.spotix.com.ng"}/polls/${pollId}/edit`

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "teams@spotix.com.ng", Name: "Spotix Teams" },
            To: [{ Email: email, Name: recipientName }],
            TemplateID: POLL_TEAM_ADDED_TEMPLATE_ID,
            TemplateLanguage: true,
            Subject: `You've been added to the "${pollName}" poll team`,
            Variables: {
              year: new Date().getFullYear().toString(),
              recipient_name: recipientName,
              adder_name: adderName,
              poll_name: pollName,
              poll_url: pollUrl,
            },
          },
        ],
      })

      console.log(`Poll team added notification sent to ${email} for poll ${pollId}`)

      return {
        success: true,
        message: "Poll team notification sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending poll team notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send poll team notification",
        error: error.message,
      })
    }
  })
}
