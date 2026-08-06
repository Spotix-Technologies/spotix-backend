import { mailjet } from "./_mailjet-client.js"

// Route: Agent onboarding
export default async function agentOnboardRoute(fastify, options) {
  fastify.post("/agent-onboard", async (request, reply) => {
    try {
      const { email, name, agent_id, username } = request.body

      if (!email || !agent_id) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for agent notification",
        })
      }

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "agent@spotix.com.ng", Name: "Spotix" },
            To: [{ Email: email, Name: name || username || "Spotix Agent" }],
            TemplateID: 6989783,
            TemplateLanguage: true,
            Subject: "Howdy! You're an agent",
            Variables: {
              year: new Date().getFullYear().toString(),
              agent_id: agent_id,
              username: username || name || "Agent",
            },
          },
        ],
      })

      console.log("Agent onboarding email sent successfully to:", email)

      return {
        success: true,
        message: "Agent notification sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending agent notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send agent notification",
        error: error.message,
      })
    }
  })
}
