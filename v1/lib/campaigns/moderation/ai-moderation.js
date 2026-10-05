/**
 * v1/lib/campaigns/moderation/ai-moderation.js
 *
 * Second moderation pass, powered by Gemini 2.5 Flash-Lite (spec ask —
 * cheap/fast model, good enough for a classification task like this).
 * Runs after wordlist-check.js's cheap local pass and re-checks for
 * everything that pass can't catch:
 *   - prohibited/inappropriate language phrased in a way the wordlist
 *     doesn't literally contain
 *   - asking, hinting at, or encouraging attendees to send money to a
 *     private/personal account outside Spotix
 *   - asking attendees to bypass Spotix's official payment process
 *   - soliciting loans or contributions from attendees
 *   - attempting to trick attendees in any way
 *   - claims about the event (name, venue, date/time, ticket prices)
 *     that don't match what's actually on record for the event — the
 *     real values are injected into the prompt precisely so the model
 *     can catch a booker contradicting their own event
 *
 * Ordinary promotion, reminders, and announcements are explicitly told
 * NOT to be flagged — the bar here is "actually wrong or exploitative",
 * not "salesy".
 *
 * Uses the same @google/generative-ai SDK already used by
 * v1/gemini/enhance.js, so no new dependency.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL_ID = "gemini-2.5-flash-lite";

export class ModerationUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ModerationUnavailableError";
    this.cause = cause;
  }
}

function formatTicketPrices(ticketPrices) {
  if (!Array.isArray(ticketPrices) || !ticketPrices.length) return "Free / not specified";
  return ticketPrices
    .map((t) => {
      const tier = t?.policy || "Ticket";
      const price = t?.price !== undefined && t?.price !== "" ? `₦${t.price}` : "price not set";
      return `- ${tier}: ${price}`;
    })
    .join("\n");
}

function buildPrompt({
  campaignName,
  messageText,
  ctaText,
  eventName,
  eventVenue,
  eventDate,
  eventStart,
  eventEnd,
  ticketPrices,
  isFree,
}) {
  return `You are a content moderator for Spotix, a Nigerian event ticketing platform. Bookers (event organizers) send marketing/announcement emails to their own ticket-buying attendees through Spotix's campaign system. Your job is to decide whether ONE such email should be blocked before it sends.

REAL EVENT DETAILS ON RECORD (ground truth — the booker cannot override these):
- Event name: ${eventName || "Not specified"}
- Venue/location: ${eventVenue || "Not specified"}
- Event date: ${eventDate || "Not specified"}
- Start time: ${eventStart || "Not specified"}
- End time: ${eventEnd || "Not specified"}
- Free event: ${isFree ? "Yes" : "No"}
- Ticket prices on record:
${formatTicketPrices(ticketPrices)}

THE EMAIL TO REVIEW:
- Subject/campaign name: ${campaignName || "(none)"}
- Call-to-action button text: ${ctaText || "View Event"}
- Message body (plain text, as written by the booker):
"""
${messageText || "(empty message)"}
"""

FLAG the email if it does ANY of the following:
1. Contains cuss words, slurs, harassment, or other inappropriate/offensive language.
2. Asks, hints at, or encourages attendees to send/transfer money to a private or personal account instead of paying through Spotix.
3. Asks attendees to bypass Spotix's official payment process in any way (e.g. "pay me directly", "skip the app fee", "message me on WhatsApp to pay").
4. Solicits loans or contributions/donations from attendees.
5. Attempts to trick, mislead, or deceive attendees in any way (phishing for OTP/PIN/BVN/bank details, fake urgency, fake prizes, impersonation, etc).
6. States facts about the event (name, venue, date, time, or ticket prices) that contradict the real event details listed above.

DO NOT flag ordinary promotion, reminders, announcements, schedule updates, or enthusiastic marketing language — that is the normal, expected use of this feature. Only flag genuine violations of the rules above.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"flagged": boolean, "category": string, "reason": string, "suggestedFix": string}

- "category" must be one of: "language", "payment_bypass", "solicitation", "deception", "event_mismatch", "none".
- "reason" is a short (1-2 sentence) human-readable explanation a booker could read and understand, or "" if not flagged.
- "suggestedFix" is concrete, actionable advice (1-3 sentences) on how the booker can rewrite the message so it would pass — quote the problematic wording and say what to replace or remove — or "" if not flagged.`;
}

/**
 * Calls Gemini to classify a campaign message. Throws
 * ModerationUnavailableError on any API/parsing failure — callers should
 * treat that as "couldn't verify" and fail safe (keep the campaign from
 * sending rather than silently letting it through), never as "clean".
 */
export async function moderateWithGemini(input) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ModerationUnavailableError("GEMINI_API_KEY is not configured");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  });

  const prompt = buildPrompt(input);

  let text;
  try {
    const result = await model.generateContent(prompt);
    text = result.response.text();
  } catch (err) {
    throw new ModerationUnavailableError("Gemini request failed", err);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ModerationUnavailableError("Gemini returned non-JSON output", err);
  }

  const category = typeof parsed.category === "string" ? parsed.category : "none";
  return {
    flagged: !!parsed.flagged,
    category: parsed.flagged ? category : "none",
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    suggestedFix: typeof parsed.suggestedFix === "string" ? parsed.suggestedFix : "",
  };
}
