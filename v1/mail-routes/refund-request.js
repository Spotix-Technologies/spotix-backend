import { mailjet } from "./_mailjet-client.js"

// Route: New refund request notification
export default async function refundRequestRoute(fastify, options) {
  fastify.post("/refund-request", async (request, reply) => {
    try {
      const {
        refundId,
        userEmail,
        userName,
        eventName,
        ticketType,
        ticketPrice,
        refundReason,
        customReason,
        moreInformation,
        ticketReference,
        requestDate,
        requestTime,
      } = request.body

      if (!refundId || !userEmail || !eventName || !ticketPrice) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for refund notification",
        })
      }

      // Send notification my email
      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "tickets@spotix.com.ng", Name: "Spotix Alert" },
            To: [{ Email: "mo22445boss@gmail.com", Name: "Spotix Admin" }],
            TemplateID: 7053759,
            TemplateLanguage: true,
            Subject: "New Refund Request",
            Variables: {
              refund_id: refundId,
              user_email: userEmail,
              user_name: userName || "User",
              event_name: eventName,
              ticket_type: ticketType || "Standard",
              ticket_price: `NGN ${ticketPrice.toLocaleString()}`,
              refund_reason: customReason || refundReason,
              additional_info: moreInformation || "None provided",
              ticket_reference: ticketReference || "N/A",
              request_date: requestDate || new Date().toLocaleDateString(),
              request_time: requestTime || new Date().toLocaleTimeString(),
              year: new Date().getFullYear().toString(),
            },
          },
        ],
      })

      console.log("Refund request notification sent successfully for refund ID:", refundId)

      return {
        success: true,
        message: "Refund notification sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending refund notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send refund notification",
        error: error.message,
      })
    }
  })
}
