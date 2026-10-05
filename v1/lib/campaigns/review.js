/**
 * v1/lib/campaigns/review.js
 *
 * The submit + review pipeline shared by POST /campaigns/:id/start and
 * POST /campaigns/:id/resubmit, plus the background review cycle the
 * scheduler drives.
 *
 *   submitCampaign(campaign, organizerId)
 *     1. Wordlist check — ALWAYS, instantly, regardless of
 *        isValidationAllowed. A hit flags the campaign right away.
 *     2. isValidationAllowed off  → reserve credits, queue immediately
 *        ("waiting_for_provider"), exactly as before moderation existed.
 *     3. isValidationAllowed on   → status "pending_review". Credits are
 *        NOT reserved yet (only checked), so a campaign that fails review
 *        never has to give any back.
 *
 *   runPendingReviews()  (called at the top of every processing cycle)
 *     For each "pending_review" campaign: run the Gemini stage.
 *       clean       → reserve credits, "waiting_for_provider", sent by
 *                     the normal worker in the same cycle
 *       flagged     → "flagged", reason + AI fix suggestion stored,
 *                     organizer emailed
 *       unavailable → left pending and retried next cycle; after
 *                     MAX_REVIEW_ATTEMPTS it is flagged as "unavailable"
 *                     so the organizer can resubmit instead of waiting
 *                     forever
 */

import { supabaseAdmin } from "../supabase-admin.js";
import { isValidationAllowed } from "./config.js";
import {
  getOrInitEmailCredits, reserveCampaignCredits, InsufficientCreditsError,
} from "./credits.js";
import { getCampaign, updateCampaign } from "./repo.js";
import { wordlistStage, improveSuggestionWithAi, aiStage } from "./moderation/index.js";
import { sendCampaignFlaggedEmail } from "./notifications.js";

const MAX_REVIEW_ATTEMPTS = 5;
const REVIEW_BATCH = 10;

export const REVIEW_MESSAGE =
  "Our system will just check your mail for a quick audit before delivering the campaign. If we find anything, we'll shoot you an email — otherwise we'll start your campaign.";

async function flagCampaign(campaign, result) {
  const flagged = await updateCampaign(campaign.id, {
    status: "flagged",
    moderation_status: "flagged",
    moderation_category: result.category,
    moderation_reason: result.reason,
    moderation_suggestion: result.suggestion || null,
    moderation_flags: result.flags || null,
    moderation_provider: result.provider,
    moderation_checked_at: new Date().toISOString(),
  });
  await sendCampaignFlaggedEmail(flagged);
  return flagged;
}

/** Reserves credits and queues for the send worker. */
async function queueForSending(campaign, organizerId) {
  await reserveCampaignCredits(organizerId, campaign.id, campaign.event_id, campaign.total_recipients, organizerId);
  return updateCampaign(campaign.id, {
    status: "waiting_for_provider",
    credits_reserved: campaign.total_recipients,
    queued_count: campaign.total_recipients,
    started_at: new Date().toISOString(),
  });
}

/**
 * @returns one of
 *  { outcome: "flagged", campaign, result }
 *  { outcome: "insufficient_credits", available, required }
 *  { outcome: "pending_review", campaign }
 *  { outcome: "queued", campaign }
 */
export async function submitCampaign(campaign, organizerId) {
  // 1. Wordlist — always.
  let wordlistHit = wordlistStage(campaign);
  if (wordlistHit) {
    if (isValidationAllowed()) wordlistHit = await improveSuggestionWithAi(campaign, wordlistHit);
    const flagged = await flagCampaign(campaign, wordlistHit);
    return { outcome: "flagged", campaign: flagged, result: wordlistHit };
  }

  // 2. Credits check up front so the booker gets instant feedback. Credits
  //    belong to the booker's account, not the event.
  const credits = await getOrInitEmailCredits(organizerId);
  if (credits.available < campaign.total_recipients) {
    return { outcome: "insufficient_credits", available: credits.available, required: campaign.total_recipients };
  }

  // 3. AI review in the background, or straight to sending.
  if (isValidationAllowed()) {
    const pending = await updateCampaign(campaign.id, {
      status: "pending_review",
      moderation_status: "pending",
      moderation_attempts: 0,
      moderation_reason: null,
      moderation_suggestion: null,
      started_at: new Date().toISOString(),
    });
    return { outcome: "pending_review", campaign: pending };
  }

  try {
    const queued = await queueForSending(campaign, organizerId);
    return { outcome: "queued", campaign: queued };
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      const fresh = await getOrInitEmailCredits(organizerId);
      return { outcome: "insufficient_credits", available: fresh.available, required: campaign.total_recipients };
    }
    throw err;
  }
}

/** Background cycle — see file header. Safe to run concurrently-ish: a
 *  campaign's status is re-checked right before it's acted on. */
export async function runPendingReviews(log = console) {
  const summary = { reviewed: 0, passed: 0, flagged: 0, retried: 0 };
  if (!isValidationAllowed()) return summary;

  const { data: pending, error } = await supabaseAdmin
    .from("campaigns")
    .select("*")
    .eq("status", "pending_review")
    .order("started_at", { ascending: true })
    .limit(REVIEW_BATCH);
  if (error) throw error;

  for (const row of pending || []) {
    const campaign = await getCampaign(row.id);
    if (!campaign || campaign.status !== "pending_review") continue;

    const result = await aiStage(campaign);
    summary.reviewed += 1;

    if (result.unavailable) {
      const attempts = (campaign.moderation_attempts || 0) + 1;
      log.error?.(`[campaign-review] Gemini unavailable for ${campaign.id} (attempt ${attempts}): ${result.error?.message}`);
      if (attempts >= MAX_REVIEW_ATTEMPTS) {
        await flagCampaign(campaign, {
          flagged: true,
          category: "unavailable",
          provider: "unavailable",
          reason: "Our review system couldn't check this campaign after several tries.",
          suggestion: "Nothing is wrong with your message that we know of — please resubmit it and we'll review it again.",
          flags: null,
        });
        summary.flagged += 1;
      } else {
        await updateCampaign(campaign.id, { moderation_attempts: attempts });
        summary.retried += 1;
      }
      continue;
    }

    if (result.flagged) {
      await flagCampaign(campaign, result);
      summary.flagged += 1;
      continue;
    }

    try {
      await updateCampaign(campaign.id, {
        moderation_status: "passed",
        moderation_provider: "gemini",
        moderation_checked_at: new Date().toISOString(),
      });
      await queueForSending(campaign, campaign.organizer_id);
      summary.passed += 1;
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        // Credits were checked at submit time; they must have been spent
        // elsewhere since. Nothing was reserved, so nothing to give back.
        await updateCampaign(campaign.id, { status: "failed", moderation_reason: "Not enough email credits when the review finished." });
        log.error?.(`[campaign-review] ${campaign.id} passed review but credits ran out`);
      } else {
        throw err;
      }
    }
  }
  return summary;
}
