// v1/lib/post-mortem/build.js
//
// Orchestrates one event's Attendee Post Mortem: claim → fetch → compute
// → render → upload → mark ready → email. Mirrors the shape of
// v1/lib/payout/process.js — claimGeneration() does a single conditional
// write so two concurrent /generate calls for the same event can't both
// think they own it, and the route only awaits the (fast) claim step
// before responding; the actual work runs in the background.

import { supabaseAdmin } from "../supabase-admin.js";
import {
  fetchEventForPostMortem,
  fetchAttendeesForPostMortem,
  fetchReferralsForPostMortem,
  fetchSurveyQuestionsForPostMortem,
  fetchSurveyResponsesForPostMortem,
  hasEventEnded,
} from "./data.js";
import { computeStats, computeSurveyStats } from "./stats.js";
import { renderPostMortemPdf } from "./pdf.js";
import { sendPostMortemReadyEmail } from "./send-ready-email.js";

const TABLE = "post_mortems";
const BUCKET = "post-mortems";

function storagePathFor(eventId) {
  return `${eventId}.pdf`;
}

/**
 * Attempts to claim generation for this event.
 * Returns { claimed: true, row } if this call is the one that should run
 * the pipeline, or { claimed: false, row } if a report already exists
 * (ready, currently processing, or — only "failed" is reclaimable).
 */
export async function claimGeneration({ eventId, eventName, requestedBy }) {
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from(TABLE)
    .select("*")
    .eq("event_id", eventId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;

  if (!existing) {
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from(TABLE)
      .insert({
        event_id: eventId,
        event_name: eventName,
        status: "processing",
        requested_by_uid: requestedBy.uid,
        requested_by_email: requestedBy.email,
        requested_by_username: requestedBy.username || null,
        requested_by_name: requestedBy.fullName || requestedBy.username || null,
      })
      .select()
      .maybeSingle();

    if (insertErr) {
      // Unique-violation on event_id = a concurrent request won the race
      // between our select and our insert. Treat it the same as "already
      // exists" rather than erroring out.
      if (insertErr.code === "23505") {
        const { data: raceRow } = await supabaseAdmin.from(TABLE).select("*").eq("event_id", eventId).maybeSingle();
        return { claimed: false, row: raceRow };
      }
      throw insertErr;
    }
    return { claimed: true, row: inserted };
  }

  if (existing.status === "failed") {
    const { data: reclaimed, error: updateErr } = await supabaseAdmin
      .from(TABLE)
      .update({
        status: "processing",
        error: null,
        requested_by_uid: requestedBy.uid,
        requested_by_email: requestedBy.email,
        requested_by_username: requestedBy.username || null,
        requested_by_name: requestedBy.fullName || requestedBy.username || null,
        created_at: new Date().toISOString(),
        completed_at: null,
        storage_path: null,
      })
      .eq("event_id", eventId)
      .eq("status", "failed") // conditional — only wins if it's still "failed"
      .select()
      .maybeSingle();

    if (updateErr) throw updateErr;
    if (!reclaimed) {
      const { data: current } = await supabaseAdmin.from(TABLE).select("*").eq("event_id", eventId).maybeSingle();
      return { claimed: false, row: current };
    }
    return { claimed: true, row: reclaimed };
  }

  // status is "processing" or "ready" — nothing to do, caller reads status
  return { claimed: false, row: existing };
}

async function markFailed(eventId, message) {
  try {
    await supabaseAdmin
      .from(TABLE)
      .update({ status: "failed", error: String(message || "Unknown error").slice(0, 500) })
      .eq("event_id", eventId);
  } catch {
    // best-effort — if even this fails the row is stuck "processing",
    // which GET /status surfaces as-is rather than hiding
  }
}

/** The actual pipeline — always call after a successful claim. Never
 *  throws; failures are recorded on the row instead so status polling
 *  surfaces them. */
export async function runGeneration(fastify, { eventId, eventName, requestedBy }) {
  const log = fastify?.log || console;
  try {
    const event = await fetchEventForPostMortem(eventId);
    if (!event) {
      await markFailed(eventId, "Event not found");
      return;
    }
    if (!hasEventEnded(event)) {
      await markFailed(eventId, "Event has not ended yet");
      return;
    }

    const [attendees, referrals] = await Promise.all([
      fetchAttendeesForPostMortem(eventId),
      fetchReferralsForPostMortem(eventId),
    ]);
    const stats = computeStats(attendees, referrals);

    // Survey is optional — an event without a form has no questions
    // subcollection at all, so this is just an empty array, and the PDF
    // renderer skips the section entirely when there's nothing to show.
    const [questions, responses] = await Promise.all([
      fetchSurveyQuestionsForPostMortem(eventId),
      fetchSurveyResponsesForPostMortem(eventId),
    ]);
    const surveyStats = computeSurveyStats(questions, responses);

    // Computed once, used both on the PDF's "Generated by ... on ..." line
    // and as the DB's completed_at — so what the report says and what
    // GET /status reports back are never a few seconds out of sync.
    const generatedAt = new Date();
    const generatedByName = requestedBy.fullName || requestedBy.username || requestedBy.email;

    const pdfBuffer = await renderPostMortemPdf({ event, stats, surveyStats, generatedByName, generatedAt });

    const storagePath = storagePathFor(eventId);
    const { error: uploadErr } = await supabaseAdmin.storage.from(BUCKET).upload(storagePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (uploadErr) throw uploadErr;

    const { error: updateErr } = await supabaseAdmin
      .from(TABLE)
      .update({ status: "ready", storage_path: storagePath, completed_at: generatedAt.toISOString() })
      .eq("event_id", eventId);
    if (updateErr) throw updateErr;

    let downloadUrl = null;
    try {
      const { data: signed } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60 * 24);
      downloadUrl = signed?.signedUrl || null;
    } catch (signErr) {
      log.warn?.(`[post-mortem] failed to mint signed URL for email (${eventId}): ${signErr?.message}`);
    }

    await sendPostMortemReadyEmail({
      email: requestedBy.email,
      username: requestedBy.username,
      eventName,
      downloadUrl,
    }).catch((err) => {
      log.error?.(`[post-mortem] ready-email send failed for ${eventId}: ${err?.message}`);
    });

    log.info?.(`[post-mortem] generation complete for event ${eventId}`);
  } catch (err) {
    log.error?.(`[post-mortem] generation failed for event ${eventId}: ${err?.message}`);
    await markFailed(eventId, err?.message);
  }
}
