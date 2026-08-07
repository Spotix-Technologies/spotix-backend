// v1/lib/ticket/confirmation-email.js
//
// Step 11 of ticket generation: send the buyer their ticket confirmation
// email via the backend's own /v1/mail/payment-confirmation route.
// Non-blocking — tickets already exist by this point.

export async function sendConfirmationEmail(
  fastify,
  { paymentData, reference, createdTicketIds, totalTicketCount, ticketTypesArray, buyerFullName, buyerEmail }
) {
  try {
    const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:2000";
    const ticketTypeSummary = ticketTypesArray
      .map((item) => `${item.type}${Number(item.quantity) > 1 ? ` x${item.quantity}` : ""}`)
      .join(", ");
    const emailPayload = {
      email: buyerEmail,
      name: buyerFullName || "Valued Customer",
      ticket_IDs: createdTicketIds.join(", "),
      ticket_references: reference,
      event_host: paymentData.bookerName || "Event Host",
      event_name: paymentData.eventName,
      payment_ref: reference,
      ticket_types: ticketTypeSummary,
      booker_email: paymentData.bookerEmail || "support@spotix.com.ng",
      total_amount: (paymentData.totalAmount).toFixed(2),
      ticket_count: totalTicketCount,
      payment_method: "Paystack",
    };

    const emailResponse = await fetch(`${BACKEND_URL}/v1/mail/payment-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(emailPayload),
    });

    if (emailResponse.ok) {
      fastify.log.info("[step:11] Confirmation email sent");
    } else {
      const responseBody = await emailResponse.text();
      fastify.log.warn(`[step:11] Email failed — status: ${emailResponse.status} | body: ${responseBody}`);
    }
  } catch (error) {
    fastify.log.error(`[step:11] Email error (non-blocking): ${error.message}`, { stack: error.stack });
  }
}
