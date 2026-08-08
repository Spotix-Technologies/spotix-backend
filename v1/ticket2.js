import { adminDb } from "./firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { isValidTicketReference } from "./lib/reference-format.js";

/**
 * Free Ticket Generation Route
 * Handles free ticket creation without payment verification
 * Skips steps 7 (atomic operations) and 11 (analytics) from paid tickets
 */
export default async function freeTicketRoute(fastify, options) {
  /**
   * POST /ticket/free
   * Body: { reference: string }
   * Creates free ticket without payment verification
   */
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

      // Verify reference format for free tickets
      if (!isValidTicketReference(reference)) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Invalid reference format. Expected format: SPTX-REF-{timestamp}-{2 letters}",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      fastify.log.info(`Processing free ticket generation for reference: ${reference}`);

      // Step 1: Get reference data (should already be "settled")
      const referenceDocRef = adminDb.collection("Reference").doc(reference);
      const referenceDoc = await referenceDocRef.get();

      if (!referenceDoc.exists) {
        return reply.code(404).send({
          error: "Not Found",
          message: "Free ticket reference not found",
          reference,
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      const paymentData = referenceDoc.data();

      // Verify it's a free ticket and status is settled
      if (paymentData.vendor !== "free ticket" || paymentData.status !== "settled") {
        return reply.code(400).send({
          error: "Invalid Reference",
          message: "This reference is not for a free ticket",
          reference,
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      // Step 2: Generate Ticket ID atomically using transaction
      let ticketId = null;
      const now = new Date();

      try {
        await adminDb.runTransaction(async (transaction) => {
          const refDoc = await transaction.get(referenceDocRef);
          
          if (!refDoc.exists) {
            throw new Error("Reference document not found during transaction");
          }

          const refData = refDoc.data();

          // Check if ticketId already exists
          if (refData.ticketId) {
            ticketId = refData.ticketId;
            fastify.log.info(`Existing ticket ID found: ${ticketId}`);
          } else {
            // Generate new ticket ID atomically
            ticketId = generateTicketId();
            fastify.log.info(`Generated new ticket ID: ${ticketId}`);

            // Atomically update Reference with new ticketId
            transaction.update(referenceDocRef, {
              ticketId,
              ticketIdGeneratedAt: now.toISOString(),
              updatedAt: now.toISOString(),
            });
          }
        });

        fastify.log.info(`Transaction completed with ticketId: ${ticketId}`);
      } catch (transactionError) {
        fastify.log.error("Transaction failed:", transactionError);
        throw new Error(`Failed to generate ticket ID: ${transactionError.message}`);
      }

      const purchaseDate = now.toLocaleDateString();
      const purchaseTime = now.toLocaleTimeString();

      // Step 3: Get user data
      const userDocRef = adminDb.collection("users").doc(paymentData.userId);
      const userDoc = await userDocRef.get();

      if (!userDoc.exists) {
        return reply.code(404).send({
          error: "User Not Found",
          message: "User data not found. Please contact support.",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      const userData = userDoc.data();

      // Step 4: Prepare ticket data for free event
      const ticketData = {
        uid: paymentData.userId,
        fullName: userData.fullName || userData.username || "",
        email: userData.email || "",
        phoneNumber: userData.phoneNumber || "",
        ticketType: paymentData.ticketType,
        ticketId,
        ticketReference: reference,
        purchaseDate,
        purchaseTime,
        verified: false,
        paymentMethod: "Free Ticket", // Free Ticket instead of Paystack
        originalPrice: 0, // Free
        ticketPrice: 0, // Free
        transactionFee: 0, // No fee for free events
        totalAmount: 0, // Free
        discountApplied: false, // No discounts for free events
        discountCode: null,
        referralCode: paymentData.referralCode || null,
        referralName: paymentData.referralName || null,
        eventVenue: paymentData.eventVenue || null,
        eventType: paymentData.eventType || null,
        eventDate: paymentData.eventDate || null,
        eventEndDate: paymentData.eventEndDate || null,
        eventStart: paymentData.eventStart || null,
        eventEnd: paymentData.eventEnd || null,
        createdAt: now.toISOString(),
      };

      // Step 5: Create ticket in TicketHistory
      const ticketHistoryRef = adminDb
        .collection("TicketHistory")
        .doc(paymentData.userId)
        .collection("tickets")
        .doc(ticketId);

      const ticketHistoryDoc = await ticketHistoryRef.get();

      if (!ticketHistoryDoc.exists) {
        const ticketHistoryData = {
          ...ticketData,
          eventId: paymentData.eventId,
          eventName: paymentData.eventName,
          eventCreatorId: paymentData.eventCreatorId,
        };

        await ticketHistoryRef.set(ticketHistoryData);
        fastify.log.info(`Free ticket created in TicketHistory: ${ticketId}`);
      } else {
        fastify.log.info(`Free ticket already exists in TicketHistory: ${ticketId}`);
      }

      // Step 6: Create ticket in attendees
      const attendeeDocRef = adminDb
        .collection("events")
        .doc(paymentData.eventCreatorId)
        .collection("userEvents")
        .doc(paymentData.eventId)
        .collection("attendees")
        .doc(ticketId);

      const attendeeDoc = await attendeeDocRef.get();

      if (!attendeeDoc.exists) {
        await attendeeDocRef.set(ticketData);
        fastify.log.info(`Free ticket created in attendees: ${ticketId}`);
      } else {
        fastify.log.info(`Free ticket already exists in attendees: ${ticketId}`);
      }

// NEW: Step 7 - Call atomic operations for free tickets (with price 0)
try {
  const ATOMIC_API_URL = process.env.ATOMIC_API_URL;

  if (ATOMIC_API_URL) {
    fastify.log.info("Calling atomic operations API for free ticket");

    const atomicResponse = await fetch(ATOMIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ticketId,
        creatorId: paymentData.eventCreatorId,     // matches AtomicOperationsRequest
        eventId: paymentData.eventId,
        ticketType: paymentData.ticketType,        // important: pass the actual free ticket type
        ticketPrice: 0,                            // free ticket → no revenue change
        discountCode: null,                        // no discount on free tickets
      }),
    });

    if (atomicResponse.ok) {
      const atomicResult = await atomicResponse.json();

      if (atomicResult.alreadyProcessed) {
        fastify.log.info(`Atomic operations already processed for free ticket ${ticketId}`);
      } else {
        fastify.log.info("Atomic operations executed successfully for free ticket");
      }
    } else {
      fastify.log.warn(`Atomic API returned ${atomicResponse.status} for free ticket - still proceeding`);
    }
  } else {
    fastify.log.warn("ATOMIC_API_URL not configured - skipping atomic ops for free ticket");
  }
} catch (atomicError) {
  fastify.log.error("Error calling atomic ops for free ticket (non-blocking):", atomicError);
}

      // Step 8: Handle referral code if present
      if (paymentData.referralCode || paymentData.referralName) {
        try {
          const referralCode = paymentData.referralCode || paymentData.referralName;
          const referralDocRef = adminDb
            .collection("events")
            .doc(paymentData.eventCreatorId)
            .collection("userEvents")
            .doc(paymentData.eventId)
            .collection("referrals")
            .doc(referralCode);

          const referralDoc = await referralDocRef.get();

          if (referralDoc.exists) {
            await referralDocRef.update({
              usages: FieldValue.arrayUnion({
                name: userData.fullName || userData.username || "Unknown",
                ticketType: paymentData.ticketType,
                purchaseDate: now,
              }),
              totalTickets: FieldValue.increment(1),
            });
            fastify.log.info(`Referral code ${referralCode} updated for free ticket`);
          }
        } catch (error) {
          fastify.log.error("Error updating referral:", error);
        }
      }

      // Step 9: Save to admin collection
      const adminTicketRef = adminDb
        .collection("admin")
        .doc("events")
        .collection(paymentData.eventId)
        .doc(ticketId);

      const adminTicketDoc = await adminTicketRef.get();

      if (!adminTicketDoc.exists) {
        await adminTicketRef.set({
          reference,
          uid: paymentData.userId,
          ticketPrice: 0, // Free
          ticketType: paymentData.ticketType,
          date: now.toISOString(),
          purchaseDate,
          purchaseTime,
          eventName: paymentData.eventName,
          eventCreatorId: paymentData.eventCreatorId,
        });

        fastify.log.info(`Free ticket saved to admin collection: ${ticketId}`);
      } else {
        fastify.log.info(`Free ticket already exists in admin collection: ${ticketId}`);
      }

      // Step 10: Mark ticket generation as complete in Reference
      await referenceDocRef.update({
        ticketGenerated: true,
        ticketGeneratedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });

      fastify.log.info("Reference updated - free ticket generation complete");

// ────────────────────────────────────────────────────────────────
// NEW: Step 7c – Update global platform analytics for free tickets
// ────────────────────────────────────────────────────────────────
try {
  const ANALYTICS_FUNCTION_URL = process.env.ANALYTICS_FUNCTION_URL;

  if (ANALYTICS_FUNCTION_URL) {
    fastify.log.info("Calling analytics endpoint for free ticket");

    const analyticsResponse = await fetch(ANALYTICS_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ticketPrice: 0,                    // ← crucial: no revenue impact
        ticketId,                          // used for idempotency
        eventId: paymentData.eventId,
        timestamp: now.toISOString(),      // helps with correct Nigerian time bucketing
      }),
    });

    if (analyticsResponse.ok) {
      const analyticsResult = await analyticsResponse.json();

      if (analyticsResult.alreadyProcessed) {
        fastify.log.info(`Analytics already processed for free ticket ${ticketId}`);
      } else {
        fastify.log.info("Global analytics updated successfully for free ticket");
      }
    } else {
      const status = analyticsResponse.status;
      fastify.log.warn(`Analytics API returned ${status} for free ticket – proceeding anyway`);
      // Optional: could await analyticsResponse.text() to log error message
    }
  } else {
    fastify.log.warn("ANALYTICS_FUNCTION_URL not set → skipping analytics for free ticket");
  }
} catch (analyticsError) {
  fastify.log.error("Failed to update global analytics for free ticket (non-blocking):", analyticsError);
}

      // Step 12: Send confirmation email with Free Ticket details
      try {
        const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";
        
        const emailResponse = await fetch(`${BACKEND_URL}/api/mail/payment-confirmation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: userData.email,
            name: userData.fullName || userData.username || "Valued Customer",
            ticket_ID: ticketId,
            event_host: paymentData.bookerName || "Event Host",
            event_name: paymentData.eventName,
            payment_ref: reference,
            ticket_type: paymentData.ticketType,
            booker_email: paymentData.bookerEmail || "support@spotix.com.ng",
            ticket_price: "Free", // Show "Free" instead of price
            payment_method: "Free Ticket", // Show "Free Ticket" instead of Paystack
          }),
        });

        if (emailResponse.ok) {
          fastify.log.info("Free ticket confirmation email sent");
        } else {
          fastify.log.warn("Failed to send confirmation email - ticket still created");
        }
      } catch (error) {
        fastify.log.error("Error sending confirmation email (non-blocking):", error);
      }

      // Step 13: Return success response
      return reply.code(200).send({
        success: true,
        message: "Free ticket generated successfully",
        ticketId,
        ticketReference: reference,
        eventId: paymentData.eventId,
        eventName: paymentData.eventName,
        ticketType: paymentData.ticketType,
        ticketPrice: 0,
        totalAmount: 0,
        userData: {
          fullName: userData.fullName || userData.username || "",
          email: userData.email || "",
        },
        eventDetails: {
          eventVenue: paymentData.eventVenue,
          eventType: paymentData.eventType,
          eventDate: paymentData.eventDate,
          eventEndDate: paymentData.eventEndDate,
          eventStart: paymentData.eventStart,
          eventEnd: paymentData.eventEnd,
          bookerName: paymentData.bookerName,
          bookerEmail: paymentData.bookerEmail,
        },
        referralUsed: paymentData.referralCode ? true : false,
        developer: "API developed and maintained by Spotix Technologies",
      });
    } catch (error) {
      fastify.log.error("Free ticket generation error:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
      
      return reply.code(500).send({
        error: "Internal Server Error",
        message: "Failed to generate free ticket",
        details: error?.message || String(error),
        developer: "API developed and maintained by Spotix Technologies",
      });
    }
  });

  /**
   * Health check for free ticket endpoint
   */
  fastify.get("/ticket/free/health", async (request, reply) => {
    return reply.code(200).send({
      status: "healthy",
      service: "Free Ticket Generation API",
      timestamp: new Date().toISOString(),
      developer: "API developed and maintained by Spotix Technologies",
    });
  });
}

/**
 * Generate unique ticket ID
 * Format: SPTX-TX-{numbers}{letters}
 */
function generateTicketId() {
  const randomNumbers = Math.floor(10000000 + Math.random() * 90000000).toString();
  const randomLetters = Math.random().toString(36).substring(2, 4).toUpperCase();

  const pos1 = Math.floor(Math.random() * 8);
  const pos2 = Math.floor(Math.random() * 7) + pos1 + 1;

  const part1 = randomNumbers.substring(0, pos1);
  const part2 = randomNumbers.substring(pos1, pos2);
  const part3 = randomNumbers.substring(pos2);

  return `SPTX-TX-${part1}${randomLetters[0]}${part2}${randomLetters[1]}${part3}`;
}