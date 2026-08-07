import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): drop in the real Mailjet Template ID once the "Team member
// changed" template is published — left blank on purpose, same pattern as
// vault-notify.js.
const TEAM_MEMBER_CHANGED_TEMPLATE_ID = 8255132

const BUILT_IN_ROLE_LABELS = {
  admin: "Admin",
  checkin: "Check-in",
  accountant: "Accountant",
}

// Keep in sync with ALL_PERMISSIONS in spotix-booker/app/teams/page.tsx —
// this is the id -> display label map for custom-role permission tabs.
const PERMISSION_LABELS = {
  overview: "Overview",
  attendees: "Attendees",
  payouts: "Payouts",
  discounts: "Discounts",
  merch: "Merch",
  referrals: "Referrals",
  form: "Form",
  responses: "Responses",
  weather: "Weather",
  share: "Share Event",
  transfer: "Transfer Event",
}

function roleLabel(role) {
  if (BUILT_IN_ROLE_LABELS[role]) return BUILT_IN_ROLE_LABELS[role]
  return role
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Route: Team member role/permissions changed
 *
 * Fired by spotix-booker's PATCH /api/teams right after a collaboration
 * doc's role (and, for custom roles, its permissions array) is updated.
 *
 * For a built-in role (admin / checkin / accountant) `permissions` is null
 * on the collaboration doc, so `is_custom` is false and the email just
 * states the new role. For a custom role, `permissions` is the array of
 * tab ids the person now has — resolved here into display labels so the
 * email can list exactly which pages they can see.
 */
export default async function teamMemberChangedRoute(fastify, options) {
  fastify.post("/team-member-changed", async (request, reply) => {
    try {
      const { eventId, eventName, adderName, recipientName, email, role, permissions } = request.body

      if (!eventId || !eventName || !adderName || !recipientName || !email || !role) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for team member change notification",
        })
      }

      const isCustom = Array.isArray(permissions) && permissions.length > 0
      const pages = isCustom
        ? permissions.map((id) => ({ label: PERMISSION_LABELS[id] || roleLabel(String(id)) }))
        : []

      const eventUrl = `${process.env.BOOKER_APP_URL || "https://booker.spotix.com.ng"}/event-info/${eventId}`

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "teams@spotix.com.ng", Name: "Spotix Teams" },
            To: [{ Email: email, Name: recipientName }],
            TemplateID: TEAM_MEMBER_CHANGED_TEMPLATE_ID,
            TemplateLanguage: true,
            Subject: `Your role on ${eventName} has changed`,
            Variables: {
              year: new Date().getFullYear().toString(),
              recipient_name: recipientName,
              adder_name: adderName,
              event_name: eventName,
              role: roleLabel(role),
              is_custom: isCustom,
              pages,
              event_url: eventUrl,
            },
          },
        ],
      })

      console.log(`Team member changed notification sent to ${email} for event ${eventId}`)

      return {
        success: true,
        message: "Team member change notification sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending team member change notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send team member change notification",
        error: error.message,
      })
    }
  })
}
