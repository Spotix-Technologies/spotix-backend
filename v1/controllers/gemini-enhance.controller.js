// v1/controllers/gemini-enhance.controller.js
//
// Gemini-powered event description enhancement, extracted from the old
// v1/gemini/enhance.js so the route file (v1/routes/gemini-enhance.js) is
// just Fastify wiring.
//
// NOTE: this endpoint is not currently registered in server.js (same as
// v1/cron/payout.js — see that controller's note). Carried over exactly
// as found; wire it up in server.js if POST /v1/enhance is meant to be
// live.

import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export async function enhanceEventDescription(request, reply) {
  try {
    const { eventName, eventDescription, eventDate, eventVenue, eventType } = request.body;

    if (!eventName || !eventDescription || !eventDate || !eventVenue || !eventType) {
      return reply.code(400).send({ error: "Missing required event details" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    const prompt = `
      You are an expert event copywriter. Create a captivating and professional event description for the following event:
      
      Event Name: ${eventName}
      Event Type: ${eventType}
      Event Date: ${eventDate}
      Event Venue: ${eventVenue}
      
      Original Description: "${eventDescription}"
      
      Please enhance this description to make it more engaging, professional, and appealing to potential attendees.
      The enhanced description should:
      1. Be approximately 150-250 words
      2. Highlight the unique aspects of the event
      3. Create excitement and urgency
      4. Include relevant details about what attendees can expect
      5. Use professional but engaging language
      6. Maintain the core information from the original description
      
      Return only the enhanced description text without any additional commentary or formatting.
      `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const enhancedDescription = response.text().trim();

    return { enhancedDescription };
  } catch (error) {
    request.log.error("Error enhancing event description:", error);
    return reply.code(500).send({
      error: "Failed to enhance description",
      message: error.message,
    });
  }
}
