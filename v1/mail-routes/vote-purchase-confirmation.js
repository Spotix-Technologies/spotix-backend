import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): drop in the real Mailjet Template ID once the "Vote
// purchase confirmation" template (v1/emails/vote-purchase-confirmation.html)
// is published — left blank on purpose, same pattern as
// poll-team-added.js / team-member-added.js.
const VOTE_PURCHASE_CONFIRMATION_TEMPLATE_ID = 8258168

/**
 * Route: Vote purchase confirmation
 *
 * Fired by v1/lib/voting/vote-confirmation-email.js (step 6 of the vote
 * crediting pipeline in v1/lib/voting/index.js) right after a vote has
 * actually been credited onto the poll — never before, so a buyer never
 * gets a "your vote is in" receipt for a vote that didn't land.
 *
 * This route never resolves anything itself — the caller already has
 * every display-ready value from the Reference doc, so it just hands them
 * over as Mailjet template variables.
 */
export default async function votePurchaseConfirmationRoute(fastify, options) {
  fastify.post("/vote-purchase-confirmation", async (request, reply) => {
    try {
      const {
        email,
        recipientName,
        contestantName,
        voteCount,
        reference,
        pollName,
        pollUrl,
        purchaseDate,
        purchaseTime,
      } = request.body

      if (!email || !contestantName || !voteCount || !reference || !pollName) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for vote purchase confirmation",
        })
      }

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "votes@spotix.com.ng", Name: "Spotix Voting" },
            To: [{ Email: email, Name: recipientName || "Voter" }],
            TemplateID: VOTE_PURCHASE_CONFIRMATION_TEMPLATE_ID,
            TemplateLanguage: true,
            Subject: `Your vote for ${contestantName} is confirmed`,
            Variables: {
              year: new Date().getFullYear().toString(),
              recipient_name: recipientName || "there",
              contestant_name: contestantName,
              vote_count: String(voteCount),
              reference,
              poll_name: pollName,
              poll_url: pollUrl || "https://spotix.com.ng",
              purchase_date: purchaseDate || "-",
              purchase_time: purchaseTime || "-",
            },
          },
        ],
      })

      console.log(`Vote purchase confirmation sent to ${email} for reference ${reference}`)

      return {
        success: true,
        message: "Vote purchase confirmation sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending vote purchase confirmation:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send vote purchase confirmation",
        error: error.message,
      })
    }
  })
}
