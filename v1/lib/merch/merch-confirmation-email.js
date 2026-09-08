// v1/lib/merch/merch-confirmation-email.js
//
// Final step of merch crediting: send the buyer an order-confirmation
// receipt email via the backend's own /v1/notify/merch-purchase-confirmation
// route. Mirrors v1/lib/voting/vote-confirmation-email.js — self-fetch,
// non-blocking, only ever called after the order(s) have actually been
// credited (never on the error path in processMerchCharge, so a buyer
// never gets a receipt for an order that didn't land).
//
// Sent once per checkout (not once per cart line) — the email lists every
// item purchased and every order id generated.

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} params
 * @param {object} params.refData    — the Reference/{reference} doc data
 * @param {string} params.reference
 * @param {string[]} params.orderIds — one per cart line, in the same order as refData.merchItems
 */
export async function sendMerchConfirmationEmail(fastify, { refData, reference, orderIds }) {
  const recipientEmail = refData?.userEmail ?? null;
  if (!recipientEmail) {
    fastify.log.warn(`[merch] No buyer email on reference ${reference} — skipping confirmation email`);
    return;
  }

  try {
    const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:2000";

    // Prefer the moment the payment actually completed (stamped by
    // markReferenceStatus just before crediting) over "now", so a
    // reconciled-late reference still shows the real purchase time.
    const purchaseTimestamp = refData?.paymentCompletedAt ?? refData?.createdAt ?? new Date().toISOString();
    const purchaseDateObj = new Date(purchaseTimestamp);

    const purchaseDate = new Intl.DateTimeFormat("en-NG", {
      timeZone: "Africa/Lagos",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(purchaseDateObj);

    const purchaseTime =
      new Intl.DateTimeFormat("en-NG", {
        timeZone: "Africa/Lagos",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(purchaseDateObj) + " WAT";

    const items = (refData?.merchItems ?? []).map((line, i) => ({
      orderId: orderIds[i] ?? "",
      productName: line.productName,
      quantity: line.quantity,
      price: line.price,
      lineTotal: line.lineTotal,
    }));

    const emailPayload = {
      email: recipientEmail,
      recipientName: refData?.userFullName ?? "there",
      eventName: refData?.eventName ?? "the event",
      reference,
      orderIds,
      items,
      totalUnitsCount: refData?.totalUnitsCount ?? 0,
      totalAmount: refData?.totalAmount ?? 0,
      buyerAddress: refData?.buyerAddress ?? "",
      purchaseDate,
      purchaseTime,
    };

    const emailResponse = await fetch(`${BACKEND_URL}/v1/notify/merch-purchase-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(emailPayload),
    });

    if (emailResponse.ok) {
      fastify.log.info(`[merch] Order confirmation email sent for ${reference}`);
    } else {
      const responseBody = await emailResponse.text();
      fastify.log.warn(`[merch] Order confirmation email failed for ${reference} — status: ${emailResponse.status} | body: ${responseBody}`);
    }
  } catch (error) {
    fastify.log.error(`[merch] Order confirmation email error for ${reference} (non-blocking): ${error.message}`, { stack: error.stack });
  }
}
