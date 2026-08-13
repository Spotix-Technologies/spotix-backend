// Free Ticket Generation Route
// Handles ticket creation for zero-amount (free) events — no payment
// gateway involved, since /api/v1/ref/free marks the Reference "successful"
// synchronously at creation time.
// v1/ticket2.js
//
// The actual step-by-step generation pipeline lives in v1/lib/free-ticket/
// — see v1/lib/free-ticket/index.js for the full breakdown of which steps
// are free-specific and which are reused directly from v1/lib/ticket/ (the
// paid pipeline). This file just wires up the Fastify route, mirroring how
// v1/ticket.js wires up the paid one.

import { generateFreeTicket } from "./lib/free-ticket/index.js";

// ─── Fastify route (frontend-triggered after a free-event Reference is
// created via /api/v1/ref/free) ─────────────────────────────────────────
export default async function freeTicketRoute(fastify, options) {
  fastify.post("/ticket/free", async (request, reply) => {
    try {
      const { reference } = request.body;

      if (!reference) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Missing required parameter: reference",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      const result = await generateFreeTicket(fastify, reference);

      return reply.code(200).send({
        success: true,
        message: result.alreadyGenerated
          ? "Free ticket was already generated"
          : `${result.totalTickets} free ticket(s) generated successfully`,
        ticketIds: result.ticketIds,
        ticketReference: reference,
        totalTickets: result.totalTickets,
        eventId: result.eventId,
        eventName: result.eventName,
        totalAmount: result.totalAmount,
        buyerInfo: result.buyerInfo,
        eventDetails: result.eventDetails,
        discountApplied: result.discountApplied,
        referralUsed: result.referralUsed,
        developer: "API developed and maintained by Spotix Technologies",
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      fastify.log.error("Free ticket generation error:", error?.message);
      fastify.log.error("Stack:", error?.stack);
      return reply.code(statusCode).send({
        error: statusCode === 500 ? "Internal Server Error" : "Request Error",
        message: error?.message || "Failed to generate free ticket",
        developer: "API developed and maintained by Spotix Technologies",
      });
    }
  });

  fastify.get("/ticket/free/health", async (request, reply) => {
    return reply.code(200).send({
      status: "healthy",
      service: "Free Ticket Generation API",
      timestamp: new Date().toISOString(),
      developer: "API developed and maintained by Spotix Technologies",
    });
  });
}
