// v1/lib/ticket/survey-delivery.js
//
// New step (9b) of ticket generation: deliver the buyer's event-survey
// responses to events/{eventId}/responses — but only from here, i.e. only
// once payment has actually been verified "successful" and the reference
// has been claimed for generation (see claim-lock.js).
//
// Previously the frontend (PaymentClient.handleProceedPayment) fired
// POST /api/v1/survey/response the moment the buyer clicked "proceed to
// payment", before Paystack was ever opened. If the buyer closed the
// Paystack modal, dropped connection, or simply abandoned checkout, their
// survey answers were still recorded against the event as if they'd
// bought a ticket. Moving delivery here means the responses only ever
// land once a ticket has actually been generated for them.
//
// The buyer's raw answers travel to this point as `surveyResponses` on
// the Reference doc, set by /api/v1/create-pay-ref (or /api/v1/ref/free)
// at reference-creation time — see PaymentClient.createPaymentReference().
// They are inert until this step runs.
//
// Runs once per reference: this module is only ever invoked from the
// "claimed" branch of generateTickets (a fresh generation), never from
// the "already_generated" short-circuit, so a reference can't have its
// survey delivered twice. Non-blocking — a failure here must never stop
// a paid ticket from being issued.

export async function deliverSurveyResponse(fastify, adminDb, paymentData, { buyerFullName, buyerEmail, isGuest }) {
  const surveyResponses = paymentData.surveyResponses;

  if (!surveyResponses || typeof surveyResponses !== "object" || Object.keys(surveyResponses).length === 0) {
    return;
  }

  try {
    const responsesRef = adminDb.collection("events").doc(paymentData.eventId).collection("responses");

    const primaryTicketType =
      paymentData.ticketType || (paymentData.ticketTypes?.[0]?.type ?? "");

    const responseData = {
      responses: surveyResponses,
      attendeeInfo: {
        fullName: buyerFullName,
        email: buyerEmail,
        ticketType: primaryTicketType,
      },
      userId: paymentData.userId || null,
      isGuest,
      submittedAt: new Date().toISOString(),
      timestamp: new Date(),
    };

    const docRef = await responsesRef.add(responseData);
    fastify.log.info(`[step:9b] Survey response delivered for ${paymentData.eventId} (${docRef.id})`);
  } catch (error) {
    fastify.log.error("[step:9b] Survey delivery error (non-blocking):", error);
  }
}
