import { adminDb } from "../utils/firebase.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Ticket Generation Route (IWSS)
 * Handles ticket creation after payment verification
 * Includes atomic operations for stats, discounts, and referrals
 */
export default async function IWSSRoute(fastify, options) {
  /**
   * POST /ticket
   * Body: { reference: string }
   * Creates ticket after verifying payment
   */
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

      // Verify reference format
      if (!reference.startsWith("SPTX-REF-")) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Invalid reference format. Expected format: SPTX-REF-{timestamp}",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      fastify.log.info(`Processing ticket generation for reference: ${reference}`);

      // Step 1: Verify payment status with retry logic
      let paymentData = null;
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        const referenceDocRef = adminDb.collection("Reference").doc(reference);
        const referenceDoc = await referenceDocRef.get();

        if (!referenceDoc.exists) {
          return reply.code(404).send({
            error: "Not Found",
            message: "Payment reference not found",
            reference,
            developer: "API developed and maintained by Spotix Technologies",
          });
        }

        paymentData = referenceDoc.data();

        if (paymentData.status === "successful") {
          break; // Payment successful, proceed
        } else if (paymentData.status === "failed") {
          return reply.code(400).send({
            error: "Payment Failed",
            message: "Payment verification failed. Please try again or contact support.",
            reference,
            developer: "API developed and maintained by Spotix Technologies",
          });
        } else if (paymentData.status === "pending") {
          attempts++;
          if (attempts < maxAttempts) {
            fastify.log.info(`Payment still pending, retrying... (${attempts}/${maxAttempts})`);
            await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
          } else {
            return reply.code(400).send({
              error: "Payment Pending",
              message: "Payment is still being processed. Please try again in a few moments.",
              reference,
              developer: "API developed and maintained by Spotix Technologies",
            });
          }
        }
      }

      // Step 2: Generate Ticket ID atomically (or retrieve existing one) using transaction
      let ticketId = null;
      const now = new Date();
      const referenceDocRef = adminDb.collection("Reference").doc(reference);

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
            fastify.log.info(`Existing ticket ID found in transaction: ${ticketId}`);
          } else {
            // Generate new ticket ID atomically
            ticketId = generateTicketId();
            fastify.log.info(`Generated new ticket ID in transaction: ${ticketId}`);

            // Atomically update Reference with new ticketId
            transaction.update(referenceDocRef, {
              ticketId,
              ticketIdGeneratedAt: now.toISOString(),
              updatedAt: now.toISOString(),
            });
          }
        });

        fastify.log.info(`Transaction completed successfully with ticketId: ${ticketId}`);
      } catch (transactionError) {
        fastify.log.error("Transaction failed:", transactionError);
        throw new Error(`Failed to generate ticket ID atomically: ${transactionError.message}`);
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

      // Step 4: Prepare ticket data
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
        paymentMethod: "IWSS",
        originalPrice: paymentData.ticketPrice || 0,
        ticketPrice: paymentData.ticketPrice || 0,
        transactionFee: paymentData.transactionFee || 0,
        totalAmount: paymentData.totalAmount || 0,
        discountApplied: paymentData.discountCode ? true : false,
        discountCode: paymentData.discountCode || null,
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

      // Step 5: Check and create ticket in TicketHistory using ticketId as document ID
      const ticketHistoryRef = adminDb
        .collection("TicketHistory")
        .doc(paymentData.userId)
        .collection("tickets")
        .doc(ticketId);

      const ticketHistoryDoc = await ticketHistoryRef.get();

      if (!ticketHistoryDoc.exists) {
        // Add event details to ticket history
        const ticketHistoryData = {
          ...ticketData,
          eventId: paymentData.eventId,
          eventName: paymentData.eventName,
          eventCreatorId: paymentData.eventCreatorId,
        };

        await ticketHistoryRef.set(ticketHistoryData);
        fastify.log.info(`Ticket created in TicketHistory with ticketId: ${ticketId}`);
      } else {
        fastify.log.info(`Ticket already exists in TicketHistory: ${ticketId}`);
      }

      // Step 6: Check and create ticket in attendees using ticketId as document ID
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
        fastify.log.info(`Ticket created in attendees with ticketId: ${ticketId}`);
      } else {
        fastify.log.info(`Ticket already exists in attendees: ${ticketId}`);
      }

      // Step 7: Call atomic operations API (ALWAYS - it handles idempotency internally)
      try {
        const ATOMIC_OPS_URL = process.env.ATOMIC_OPS_URL || "http://localhost:3000/api/atomic-operations";
        
        fastify.log.info("Calling atomic operations API");
        
        const atomicResponse = await fetch(ATOMIC_OPS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            creatorId: paymentData.eventCreatorId,
            eventId: paymentData.eventId,
            ticketType: paymentData.ticketType,
            ticketPrice: paymentData.ticketPrice,
            discountCode: paymentData.discountCode || null,
            ticketId: ticketId,
          }),
        });

        const atomicResult = await atomicResponse.json();
        
        if (atomicResponse.ok) {
          if (atomicResult.alreadyProcessed) {
            fastify.log.info(`Atomic operations already processed for ticket ${ticketId}`);
          } else {
            fastify.log.info("Atomic operations completed successfully");
            fastify.log.info(`Operations performed:`, atomicResult.operationsPerformed);
          }
        } else {
          fastify.log.error("Atomic operations failed:", atomicResult);
          // Don't fail ticket generation, but log the error
        }
      } catch (atomicError) {
        fastify.log.error("Error calling atomic operations API:", atomicError);
        // Don't fail ticket generation
      }

      // Step 8: Handle referral tracking (separate from atomic ops)
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
            fastify.log.info(`Referral code ${referralCode} updated`);
          }
        } catch (error) {
          fastify.log.error("Error updating referral:", error);
        }
      }

      // Step 9: Check and save to admin collection using ticketId as document ID
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
          ticketPrice: paymentData.ticketPrice,
          ticketType: paymentData.ticketType,
          date: now.toISOString(),
          purchaseDate,
          purchaseTime,
          eventName: paymentData.eventName,
          eventCreatorId: paymentData.eventCreatorId,
        });

        fastify.log.info(`Ticket saved to admin collection with ticketId: ${ticketId}`);
      } else {
        fastify.log.info(`Ticket already exists in admin collection: ${ticketId}`);
      }

      // Step 10: Mark ticket generation as complete in Reference
      await referenceDocRef.update({
        ticketGenerated: true,
        ticketGeneratedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });

      fastify.log.info("Reference updated - ticket generation complete");

// Step 11: Update global analytics (idempotency handled in analytics API)
try {
  const ANALYTICS_FUNCTION_URL = process.env.ANALYTICS_FUNCTION_URL;
  
  if (ANALYTICS_FUNCTION_URL) {
    fastify.log.info("Calling analytics function to update global stats");
    
    const analyticsResponse = await fetch(ANALYTICS_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ticketPrice: paymentData.ticketPrice,
        ticketId: ticketId,
        eventId: paymentData.eventId,
        timestamp: now.toISOString(),
      }),
    });

    if (analyticsResponse.ok) {
      const analyticsResult = await analyticsResponse.json();
      
      if (analyticsResult.alreadyProcessed) {
        fastify.log.info(`Analytics already processed for ticket ${ticketId}`);
      } else {
        fastify.log.info("Analytics updated successfully");
      }
    } else {
      fastify.log.warn("Failed to update analytics - ticket still created successfully");
    }
  } else {
    fastify.log.warn("ANALYTICS_FUNCTION_URL not configured - skipping analytics update");
  }
} catch (analyticsError) {
  fastify.log.error("Error updating analytics (non-blocking):", analyticsError);
}


      // Step 12: Send confirmation email (non-blocking - don't fail if email fails)
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
            ticket_price: paymentData.ticketPrice.toFixed(2),
            payment_method: "Paystack",
          }),
        });

        if (emailResponse.ok) {
          fastify.log.info("Confirmation email sent successfully");
        } else {
          fastify.log.warn("Failed to send confirmation email - ticket still created successfully");
        }
      } catch (error) {
        fastify.log.error("Error sending confirmation email (non-blocking):", error);
        // Don't fail the request - ticket was created successfully
      }

      // Step 13: Return success response (same response regardless of new or recovered)
      return reply.code(200).send({
        success: true,
        message: "Ticket generated successfully",
        ticketId,
        ticketReference: reference,
        eventId: paymentData.eventId,
        eventName: paymentData.eventName,
        ticketType: paymentData.ticketType,
        ticketPrice: paymentData.ticketPrice,
        totalAmount: paymentData.totalAmount,
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
        discountApplied: paymentData.discountCode ? true : false,
        referralUsed: paymentData.referralCode ? true : false,
        developer: "API developed and maintained by Spotix Technologies",
      });
    } catch (error) {
      fastify.log.error("Ticket generation error - FULL ERROR:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
      fastify.log.error("Error message:", error?.message);
      fastify.log.error("Error stack:", error?.stack);
      fastify.log.error("Error name:", error?.name);
      fastify.log.error("Error type:", typeof error);
      
      return reply.code(500).send({
        error: "Internal Server Error",
        message: "Failed to generate ticket",
        details: error?.message || String(error),
        developer: "API developed and maintained by Spotix Technologies",
      });
    }
  });

  /**
   * Health check for ticket endpoint
   */
  fastify.get("/ticket/health", async (request, reply) => {
    return reply.code(200).send({
      status: "healthy",
      service: "Ticket Generation API",
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