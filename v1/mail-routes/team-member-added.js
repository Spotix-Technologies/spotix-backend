import { mailjet } from "./_mailjet-client.js"

// Route: Team member added
export default async function teamMemberAddedRoute(fastify, options) {
  fastify.post("/team-member-added", async (request, reply) => {
    try {
      const { collaborationId, eventId, bookerId, userRole, eventName, bookerName, username, email, recipientName } =
        request.body

      if (!collaborationId || !eventId || !bookerId || !userRole || !eventName || !bookerName || !username || !email) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for team member notification",
        })
      }

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "teams@spotix.com.ng", Name: "Spotix Teams" },
            To: [{ Email: email, Name: recipientName || username }],
            TemplateID: 6986222,
            TemplateLanguage: true,
            Subject: "You've been added to a Spotix event team",
            Variables: {
              collab_id: collaborationId,
              event_id: eventId,
              booker_id: bookerId,
              UserRole: userRole,
              eventname: eventName,
              bookername: bookerName,
              username: username,
            },
          },
        ],
      })

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
