import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): drop in the real Mailjet Template ID once the "Event
// transfer request" template is published — left blank on purpose, same
// pattern as vault-notify.js / team-member-added.js.
const EVENT_TRANSFER_REQUEST_TEMPLATE_ID = 8255231

/**
 * Route: Event transfer request
 *
 * Fired by spotix-booker's POST /api/event/transfer (action: "create")
 * right after the transfer + userTransferRequests docs are written. Lets
 * the recipient know a booker wants to hand them full ownership of an
 * event, and that they can accept or decline it from their Spotix
 * account before the offer expires.
 *
 * This route doesn't resolve anything itself — spotix-booker already has
 * the organizer's display info and the recipient's email/username from
 * the whoru lookup + transfer doc, so it just hands over display-ready
 * values, including the pre-formatted expiry date/time.
 */
export default async function eventTransferRequestRoute(fastify, options) {
  fastify.post("/event-transfer-request", async (request, reply) => {
    try {
      const {
        eventId,
        eventName,
        organizerName,
        recipientName,
        email,
        expiresAt, // ISO string
      } = request.body

      if (!eventId || !eventName || !organizerName || !recipientName || !email || !expiresAt) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for event transfer notification",
        })
      }

      const expiryDate = new Date(expiresAt)
      const expiresLabel = isNaN(expiryDate.getTime())
        ? "soon"
        : expiryDate.toLocaleString("en-NG", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })

      // The dialog to accept/decline lives on the booker events list, not
      // a dedicated event-info tab — see app/events/page.tsx, which shows
      // EventTransferDialog whenever the recipient has a pending transfer.
      const reviewUrl = `${process.env.BOOKER_APP_URL || "https://booker.spotix.com.ng"}/events`

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "transfers@spotix.com.ng", Name: "Spotix" },
            To: [{ Email: email, Name: recipientName }],
            TemplateID: EVENT_TRANSFER_REQUEST_TEMPLATE_ID,
            TemplateLanguage: true,
            Subject: `${organizerName} wants to transfer "${eventName}" to you`,
            Variables: {
              year: new Date().getFullYear().toString(),
              recipient_name: recipientName,
              organizer_name: organizerName,
              event_name: eventName,
              expires_at: expiresLabel,
              review_url: reviewUrl,
            },
          },
        ],
      })

      console.log(`Event transfer request notification sent to ${email} for event ${eventId}`)

      return {
        success: true,
        message: "Event transfer notification sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending event transfer notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send event transfer notification",
        error: error.message,
      })
    }
  })
}
