/**
 * v1/lib/campaigns/moderation/index.js
 *
 * Two independent moderation stages:
 *
 *   1. wordlistStage — instant, local, no network call, and it ALWAYS
 *      runs the moment the booker starts a campaign, regardless of
 *      isValidationAllowed. A hit blocks the campaign immediately.
 *   2. aiStage — the Gemini semantic check (payment bypass, solicitation,
 *      deception, event-detail mismatches). Only ever called when
 *      isValidationAllowed is on, and only from the background review
 *      cycle (v1/lib/campaigns/review.js), never from the request that
 *      started the campaign.
 *
 * Both return the same shape:
 *   { flagged, reason, suggestion, category, provider, flags }
 */

import { checkWordlist } from "./wordlist-check.js";
import { moderateWithGemini, ModerationUnavailableError } from "./ai-moderation.js";

function textOf(campaign) {
  return [campaign.name, campaign.message_text].filter(Boolean).join("\n\n");
}

function geminiInput(campaign) {
  return {
    campaignName: campaign.name,
    messageText: campaign.message_text,
    ctaText: campaign.cta_text,
    eventName: campaign.event_name_snapshot,
    eventVenue: campaign.event_venue_snapshot,
    eventDate: campaign.event_date_snapshot,
    eventStart: campaign.event_start_snapshot,
    eventEnd: campaign.event_end_snapshot,
    ticketPrices: campaign.ticket_prices_snapshot,
    isFree: campaign.is_free_snapshot,
  };
}

/** Stage 1 — synchronous, always on. Returns null when clean. */
export function wordlistStage(campaign) {
  const result = checkWordlist(textOf(campaign));
  if (!result.flagged) return null;
  const shown = result.matches.slice(0, 5).map((m) => `"${m}"`).join(", ");
  return {
    flagged: true,
    reason: `This message contains language or phrasing our system automatically blocks: ${shown}.`,
    suggestion: `Remove or rephrase ${shown} and keep the message respectful and about the event.`,
    category: "language",
    provider: "wordlist",
    flags: result.matches,
  };
}

/**
 * Best-effort: when the wordlist blocks a message AND AI validation is
 * on, ask Gemini for a tailored fix instead of the generic one. Never
 * throws — falls back to the wordlist's own suggestion.
 */
export async function improveSuggestionWithAi(campaign, wordlistResult) {
  try {
    const ai = await moderateWithGemini(geminiInput(campaign));
    if (ai.suggestedFix) return { ...wordlistResult, suggestion: ai.suggestedFix };
  } catch {
    /* keep the static suggestion */
  }
  return wordlistResult;
}

/**
 * Stage 2 — Gemini. Returns { flagged: false, ... } when clean, a
 * flagged result when not, or { unavailable: true } when Gemini could
 * not be reached (the review cycle retries those rather than guessing).
 */
export async function aiStage(campaign) {
  try {
    const ai = await moderateWithGemini(geminiInput(campaign));
    return {
      flagged: ai.flagged,
      reason: ai.reason,
      suggestion: ai.suggestedFix,
      category: ai.category,
      provider: "gemini",
      flags: null,
    };
  } catch (err) {
    if (err instanceof ModerationUnavailableError) {
      return { unavailable: true, error: err };
    }
    throw err;
  }
}
