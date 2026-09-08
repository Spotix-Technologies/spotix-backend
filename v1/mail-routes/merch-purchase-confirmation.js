import { mailjet } from "./_mailjet-client.js"

// TODO(Drexx): drop in the real Mailjet Template ID once the "Merch
// purchase confirmation" template (v1/emails/merch-purchase-confirmation.html)
// is published — left blank on purpose, same pattern as
// vote-purchase-confirmation.js / poll-team-added.js.
const MERCH_PURCHASE_CONFIRMATION_TEMPLATE_ID = 8327963

function formatNaira(amount) {
  return `₦${Number(amount || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Builds the order-lines HTML fragment the template drops in verbatim via
 * {{var:items_html}} — one row per cart line item. Built server-side
 * rather than relying on Mailjet's own for-loop templating, since the
 * cart can contain any number of distinct listings and this keeps the
 * template itself simple (a single placeholder, same as every other
 * variable here).
 */
function buildItemsHtml(items) {
  return items
    .map(
      (item) => `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #f1e9fb;">
            <div style="font-weight:600;color:#1f2937;">${item.productName}</div>
            <div style="font-size:13px;color:#6b7280;">Order ID: ${item.orderId}</div>
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #f1e9fb;text-align:center;color:#374151;">
            ${item.quantity}
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #f1e9fb;text-align:right;color:#374151;">
            ${formatNaira(item.price)}
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #f1e9fb;text-align:right;font-weight:600;color:#1f2937;">
            ${formatNaira(item.lineTotal)}
          </td>
        </tr>`
    )
    .join("")
}

/**
 * Route: Merch purchase confirmation
 *
 * Fired by v1/lib/merch/merch-confirmation-email.js (step 6 of the merch
 * crediting pipeline in v1/lib/merch/index.js) right after every line
 * item in the cart has actually been credited (order rows written, stock
 * decremented) — never before, so a buyer never gets a receipt for an
 * order that didn't land.
 *
 * This route never resolves anything itself — the caller already has
 * every display-ready value from the Reference doc, so it just hands them
 * over as Mailjet template variables.
 */
export default async function merchPurchaseConfirmationRoute(fastify, options) {
  fastify.post("/merch-purchase-confirmation", async (request, reply) => {
    try {
      const {
        email,
        recipientName,
        eventName,
        reference,
        orderIds,
        items,
        totalUnitsCount,
        totalAmount,
        buyerAddress,
        purchaseDate,
        purchaseTime,
      } = request.body

      if (!email || !reference || !Array.isArray(items) || items.length === 0) {
        return reply.code(400).send({
          success: false,
          message: "Missing required fields for merch purchase confirmation",
        })
      }

      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: { Email: "orders@spotix.com.ng", Name: "Spotix Merch" },
            To: [{ Email: email, Name: recipientName || "there" }],
            TemplateID: MERCH_PURCHASE_CONFIRMATION_TEMPLATE_ID,
            TemplateLanguage: true,
            Subject: `Your order for ${eventName || "the event"} is confirmed`,
            Variables: {
              year: new Date().getFullYear().toString(),
              recipient_name: recipientName || "there",
              event_name: eventName || "the event",
              reference,
              order_ids: (orderIds || []).join(", "),
              items_html: buildItemsHtml(items),
              total_units: String(totalUnitsCount || items.reduce((s, i) => s + Number(i.quantity || 0), 0)),
              total_amount: formatNaira(totalAmount),
              buyer_address: buyerAddress || "-",
              purchase_date: purchaseDate || "-",
              purchase_time: purchaseTime || "-",
            },
          },
        ],
      })

      console.log(`Merch purchase confirmation sent to ${email} for reference ${reference}`)

      return {
        success: true,
        message: "Merch purchase confirmation sent successfully",
      }
    } catch (error) {
      fastify.log.error("Error sending merch purchase confirmation:", error)
      return reply.code(500).send({
        success: false,
        message: "Failed to send merch purchase confirmation",
        error: error.message,
      })
    }
  })
}
