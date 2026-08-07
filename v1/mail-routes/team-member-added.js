import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): drop in the real Mailjet Template ID once the "Team member
// added" template is published — left blank on purpose, same pattern as
// vault-notify.js.
const TEAM_MEMBER_ADDED_TEMPLATE_ID = 8255123

const BUILT_IN_ROLE_LABELS = {
  admin: "Admin",
  checkin: "Check-in",
  accountant: "Accountant",
}

function roleLabel(role) {
  if (BUILT_IN_ROLE_LABELS[role]) return BUILT_IN_ROLE_LABELS[role]
  // Custom role id -> Title Case for display (e.g. "eventDay" -> "Event Day")
  return role
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Route: Team member added
 *
 * Fired by spotix-booker's POST /api/teams right after a collaboration doc
 * is created. Replaces the old arrangement, which emailed the raw
 * collaborationId / eventId / bookerId as template variables (a Firestore
 * doc ID isn't something a person needs to see, so it's dropped here).
 *
 * This route never resolves anything itself — spotix-booker already knows
 * who the owner is, who the recipient is, and what role they were given,
 * so it just hands over display-ready values.
 */
export default async function teamMemberAddedRoute(fastify, options) {
  fastify.post("/team-member-added", async (request, reply) => {
    try {
      const { eventId, eventName, adderName, recipientName, email, role } = request.body

      if (!eventId || !eventName || !adderName || !recipientName || !email || !role) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for team member notification",
        })
      }

      const eventUrl = `${process.env.BOOKER_APP_URL || "https://booker.spotix.com.ng"}/event-info/${eventId}`

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "teams@spotix.com.ng", Name: "Spotix Teams" },
            To: [{ Email: email, Name: recipientName }],
            TemplateID: TEAM_MEMBER_ADDED_TEMPLATE_ID,
            TemplateLanguage: true,
            Subject: `You've been added to the ${eventName} team`,
            Variables: {
              year: new Date().getFullYear().toString(),
              recipient_name: recipientName,
              adder_name: adderName,
              event_name: eventName,
              role: roleLabel(role),
              event_url: eventUrl,
            },
          },
        ],
      })

      console.log(`Team member added notification sent to ${email} for event ${eventId}`)

      return {
        success: true,
        message: "Team member notification sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending team member notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send team member notification",
        error: error.message,
      })
    }
  })
}
