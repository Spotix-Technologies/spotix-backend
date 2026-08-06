import { mailjet } from "./_mailjet-client.js"

// Route: Agent ticket purchase notification
export default async function agentTicketRoute(fastify, options) {
  fastify.post("/agent-ticket", async (request, reply) => {
    try {
      const {
        email,
        name,
        agent_ID,
        agent_name,
        payment_method,
        ticket_price,
        booker_email,
        ticket_type,
        payment_ref,
        event_name,
        event_host,
        ticket_ID,
        year,
      } = request.body

      if (!email || !ticket_ID || !event_name) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for ticket notification",
        })
      }

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "tickets@spotix.com.ng", Name: "Spotix Tickets" },
            To: [{ Email: email, Name: name || "Valued Customer" }],
            TemplateID: 6989847,
            TemplateLanguage: true,
            Subject: "Our Agent has sold you a ticket",
            Variables: {
              year: year || new Date().getFullYear().toString(),
              agent_ID,
              agent_name,
              payment_method: payment_method || "Agent Wallet",
              ticket_price,
              booker_email: booker_email || "support@spotix.com.ng",
              ticket_type,
              payment_ref,
              event_name,
              event_host,
              ticket_ID,
              name: name || "Valued Customer",
              email,
            },
          },
        ],
      })

      console.log("Agent ticket email sent successfully to:", email)

      return {
        success: true,
        message: "Ticket notification sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending ticket notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send ticket notification",
        error: error.message,
      })
    }
  })
}
