// Ticket Generation Route
// Handles ticket creation after payment verification
// Supports multi-ticket purchases and guest checkout
// v1/ticket.js
//
// The actual step-by-step generation pipeline lives in v1/lib/ticket/ —
// see v1/lib/ticket/index.js for the full list of steps and what each one
// does. This file just wires up the Fastify route and re-exports the
// pieces webhook.js and ticket-agent.js already import from "./ticket.js",
// so neither of those files needed to change.

import { generateTickets, processAgentSale, generateTicketId } from "./lib/ticket/index.js";

// ─── Fastify route (frontend-triggered fallback / manual re-generation) ───────
export default async function ticketRoute(fastify, options) {
  fastify.post("/ticket", async (request, reply) => {
    try {
      const { reference } = request.body;

      if (!reference) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Missing required parameter: reference",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      const result = await generateTickets(fastify, reference);

      return reply.code(200).send({
        success: true,
        message: result.alreadyGenerated
          ? "Tickets were already generated"
          : `${result.totalTickets} ticket(s) generated successfully`,
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
      fastify.log.error("Ticket generation error:", error?.message);
      fastify.log.error("Stack:", error?.stack);
      return reply.code(statusCode).send({
        error: statusCode === 500 ? "Internal Server Error" : "Request Error",
        message: error?.message || "Failed to generate ticket",
        developer: "API developed and maintained by Spotix Technologies",
      });
    }
  });

  fastify.get("/ticket/health", async (request, reply) => {
    return reply.code(200).send({
      status: "healthy",
      service: "Ticket Generation API",
      timestamp: new Date().toISOString(),
      developer: "API developed and maintained by Spotix Technologies",
    });
  });
}

// Re-exported for webhook.js (generateTickets) and ticket-agent.js
// (processAgentSale, generateTicketId) — same import surface as before.
export { generateTickets, processAgentSale, generateTicketId };
