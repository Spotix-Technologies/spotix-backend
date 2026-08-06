import { mailjet } from "./_mailjet-client.js"

// Route: Agent sale notification
export default async function agentSaleRoute(fastify, options) {
  fastify.post("/agent-sale", async (request, reply) => {
    try {
      const { agent_email, agent_name, customer_email, customer_name, price, ticket_type, event_name, year } =
        request.body

      if (!agent_email || !customer_email || !event_name) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for agent sale notification",
        })
      }

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "agent@spotix.com.ng", Name: "Spotix" },
            To: [{ Email: agent_email, Name: agent_name || "Spotix Agent" }],
            TemplateID: 6989769,
            TemplateLanguage: true,
            Subject: "You have completed a sale",
            Variables: {
              year: year || new Date().getFullYear().toString(),
              customer_email,
              customer_name,
              price,
              ticket_type,
              event_name,
              agent_name: agent_name || "Agent",
            },
          },
        ],
      })

      console.log("Agent sale notification sent successfully to:", agent_email)

      return {
        success: true,
        message: "Agent sale notification sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending agent sale notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send agent sale notification",
        error: error.message,
      })
    }
  })
}
