import { MailerSend } from "mailersend"
import dotenv from "dotenv"
import { buildTicketConfirmationEmailHtml } from "./lib/mail/ticket-confirmation-template.js"

// Load environment variables
dotenv.config()

// Base URL the QR <img> tags in the ticket confirmation email point at —
// v1/qrcode.js is registered under this same backend, so it defaults to
// BACKEND_URL. Set QR_BASE_URL explicitly if QR images should be served
// from a different host (e.g. a CDN in front of this API).
const QR_BASE_URL =
  process.env.QR_BASE_URL || `${process.env.BACKEND_URL || "http://localhost:2000"}/v1/qrcode`

// Initialize MailerSend with API key
const mailersend = new MailerSend({
  apiKey: process.env.MAILERSEND_API_KEY,
})

/**
 * Send email route handler for Fastify
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Route options
 */
export default async function sendMailRoutes(fastify, options) {
  // Route for booker confirmation emails
  fastify.post("/booker-confirmation", async (request, reply) => {
    try {
      const { email, name } = request.body

      if (!email || !name) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields: email or name",
        })
      }

      const emailParams = {
        from: {
          email: "auth@spotix.com.ng",
          name: "Spotix Events",
        },
        to: [
          {
            email: email,
            name: name,
          },
        ],
        subject: "Welcome to Spotix Bookers",
        template_id: "zr6ke4n8j3e4on12",
        personalization: [
          {
            email: email,
            data: {
              name: name,
              action_url: "https://www.spotix.com.ng/dashboard",
              support_url: "support@spotix.com.ng",
            },
          },
        ],
      }

      const response = await mailersend.email.send(emailParams)

      fastify.log.info("Booker confirmation email sent successfully")
      return reply.code(200).send({
        success: true,
        message: "Booker confirmation email sent successfully",
      })
    } catch (error) {
      fastify.log.error("Error sending booker confirmation email:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send booker confirmation email",
        error: error.message,
      })
    }
  })

  // Route for payment confirmation emails
  //
  // Sends via raw `html` (built by buildTicketConfirmationEmailHtml) instead
  // of MailerSend's hosted template_id — that's what lets us render one
  // QR code per ticket, which a hosted template can't loop to do. See
  // v1/lib/mail/ticket-confirmation-template.js for the full rationale.
  fastify.post("/payment-confirmation", async (request, reply) => {
  try {
    const {
      email,
      name,
      ticket_IDs,        // legacy: comma-joined string, still accepted as a fallback
      tickets,            // preferred: [{ ticketId, ticketType }, ...], one per physical ticket
      ticket_references, 
      event_host,
      event_name,
      payment_ref,
      ticket_types,      
      booker_email,
      total_amount,     
      ticket_count,      
      payment_method,
    } = request.body

// Validate required fields
const requiredFields = {
      email,
      name,
      event_host,
      event_name,
      payment_ref,
      ticket_types,      
      booker_email,
      total_amount,     
      ticket_count,      
      payment_method,
};

const missingFields = Object.entries(requiredFields)
  .filter(([_, value]) => !value)
  .map(([key]) => key);

// tickets/ticket_IDs is validated separately since either form is acceptable
if (!Array.isArray(tickets) && !ticket_IDs) {
  missingFields.push("tickets");
}

if (missingFields.length > 0) {
  fastify.log.warn(`[payment-confirmation] Missing required fields: ${missingFields.join(", ")}`);
  return reply.code(400).send({
    success: false,
    message: "Missing required fields for payment confirmation email",
  });
}

    // Normalize to the [{ ticketId, ticketType }] shape the template expects.
    // Preferred path: caller sends `tickets` directly (see confirmation-email.js
    // and ticket-agent.js). Fallback: split the legacy comma-joined ticket_IDs
    // string and pair each with the overall ticket_types summary — used only
    // if an older caller hasn't been updated to send `tickets` yet.
    const normalizedTickets = Array.isArray(tickets) && tickets.length > 0
      ? tickets.map((t) => ({ ticketId: t.ticketId ?? t.id, ticketType: t.ticketType ?? t.type }))
      : String(ticket_IDs)
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
          .map((ticketId) => ({ ticketId, ticketType: ticket_types || "Standard" }));

    const emailHtml = buildTicketConfirmationEmailHtml({
      name,
      eventName: event_name,
      eventHost: event_host || "Spotix Event Host",
      paymentRef: ticket_references || payment_ref,
      ticketTypesSummary: ticket_types || "Standard",
      totalAmount: total_amount || "0.00",
      ticketCount: ticket_count || normalizedTickets.length || 1,
      paymentMethod: payment_method,
      bookerEmail: booker_email || "support@spotix.com.ng",
      tickets: normalizedTickets,
      qrBaseUrl: QR_BASE_URL,
    })

    const emailParams = {
      from: {
        email: "tickets@spotix.com.ng",
        name: "Spotix Tickets",
      },
      to: [
        {
          email: email,
          name: name,
        },
      ],
      subject: `Your Ticket for ${event_name}`,
      html: emailHtml,
    }

    await mailersend.email.send(emailParams)

    fastify.log.info("Payment confirmation email sent successfully")
    return reply.code(200).send({
      success: true,
      message: "Payment confirmation email sent successfully",
    })
  } catch (error) {
    fastify.log.error("Error sending payment confirmation email:", error)
    return reply.code(500).send({
      success: false,
      message: "Failed to send payment confirmation email",
      error: error.message,
    })
  }
})

  // Route for welcome emails
  fastify.post("/welcome-email", async (request, reply) => {
    try {
      const { email, name } = request.body

      if (!email || !name) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields: email or name",
        })
      }

      const emailParams = {
        from: {
          email: "auth@spotix.com.ng",
          name: "Spotix Welcome",
        },
        to: [
          {
            email: email,
            name: name,
          },
        ],
        subject: "Welcome to Spotix!",
        template_id: "3vz9dle5ydplkj50",
        personalization: [
          {
            email: email,
            data: {
              name: name,
            },
          },
        ],
      }

      const response = await mailersend.email.send(emailParams)

      fastify.log.info("Welcome email sent successfully")
      return reply.code(200).send({
        success: true,
        message: "Welcome email sent successfully",
      })
    } catch (error) {
      fastify.log.error("Error sending welcome email:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send welcome email",
        error: error.message,
      })
    }
  })
}
