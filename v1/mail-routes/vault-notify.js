import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): drop in the real Mailjet Template ID for the Vault
// notification once it's published — left blank on purpose.
const VAULT_NOTIFY_TEMPLATE_ID = 8254343

/**
 * Route: Vault payout notification
 *
 * Fired once per payout request (single day or bulk) by
 * spotix-booker's POST /api/payout/vault-notify, which is the one that
 * resolves the actual Vault participant list from Firestore
 * (`vaults/{eventId}.participants[].email`) before calling here — this
 * route only ever sees the emails it's handed, it doesn't look anything
 * up itself.
 *
 * The requester (whoever just initiated the withdrawal) must never be a
 * recipient here — spotix-booker already filters them out of
 * `participants`, but we filter again defensively by `requesterUid` /
 * `requesterEmail` in case a caller forgets.
 */
export default async function vaultNotifyRoute(fastify, options) {
  fastify.post("/vault-notify", async (request, reply) => {
    try {
      const {
        eventId,
        eventName,
        requesterUid,
        requesterName,
        requesterRoleLabel,
        requesterEmail,
        amount,
        dates,
        payoutIds,
        participants,
      } = request.body

      if (!eventId || !eventName || !requesterUid || !requesterName || amount === undefined || amount === null) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for Vault payout notification",
        })
      }

      if (!Array.isArray(dates) || dates.length === 0) {
        return reply.code(400).send({
          success: false,
          message: "dates must be a non-empty array (one entry per day being paid out)",
        })
      }

      if (!Array.isArray(participants) || participants.length === 0) {
        return reply.code(400).send({
          success: false,
          message: "participants (Vault partners to notify) is required",
        })
      }

      // Never email the person who made the request — defensive filter on
      // top of whatever spotix-booker already excluded.
      const recipients = participants.filter(
        (p) => p && p.email && p.uid !== requesterUid && p.email !== requesterEmail
      )

      if (recipients.length === 0) {
        return reply.code(200).send({
          success: true,
          message: "No other Vault participants to notify — only the requester is on the Vault.",
          notified: 0,
        })
      }

      const isBulk = dates.length > 1
      const dayList = dates.join(", ")
      const formattedAmount = `NGN ${Number(amount).toLocaleString()}`
      const year = new Date().getFullYear().toString()

      const Messages = recipients.map((participant) => ({
        From: { Email: "vault@spotix.com.ng", Name: "Spotix Vault" },
        To: [{ Email: participant.email, Name: participant.name || participant.email }],
        TemplateID: VAULT_NOTIFY_TEMPLATE_ID,
        TemplateLanguage: true,
        Subject: isBulk
          ? `Vault sign-off needed — payout for ${dates.length} days on ${eventName}`
          : `Vault sign-off needed — payout for ${eventName}`,
        Variables: {
          year,
          recipient_name: participant.name || participant.email,
          requester_name: requesterName,
          requester_role: requesterRoleLabel || "Team member",
          event_name: eventName,
          event_id: eventId,
          amount: formattedAmount,
          day_count: dates.length,
          day_list: dayList,
          is_bulk: isBulk,
          payout_ids: Array.isArray(payoutIds) ? payoutIds.join(", ") : "",
          review_url: `${process.env.BOOKER_APP_URL || "https://booker.spotix.com.ng"}/event-info/${eventId}?tab=payouts`,
        },
      }))

      await mailjet.post("send", { version: "v3.1" }).request({ Messages })

      console.log(
        `Vault payout notification sent to ${recipients.length} participant(s) for event ${eventId} (${dayList})`
      )

      return {
        success: true,
        message: `Vault notification sent to ${recipients.length} participant(s)`,
        notified: recipients.length,
      }
    } catch (error) {
      fastify.log.error("Error sending Vault payout notification:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send Vault payout notification",
        error: error.message,
      })
    }
  })
}
