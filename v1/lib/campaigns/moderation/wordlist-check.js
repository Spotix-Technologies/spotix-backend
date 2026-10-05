/**
 * v1/lib/campaigns/moderation/wordlist-check.js
 *
 * First, cheap moderation pass — a plain local wordlist match, no network
 * call. Runs before the Gemini layer (ai-moderation.js) so an obviously
 * bad message is flagged "as soon as it's seen" without paying for a
 * model call. It only ever catches what's in wordlist.json (generic
 * cuss words + known scam/bypass-payment phrases); the Gemini layer is
 * what catches everything phrased differently or requiring real
 * understanding of context (spec ask).
 *
 * Loaded with fs.readFileSync instead of a JSON import assertion — this
 * project's Node/ESM setup elsewhere (server.js) sticks to plain
 * fs-based reads for anything off the module graph, so this matches
 * that convention rather than relying on a newer import-attributes
 * syntax that may not be available on every deploy target.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORDLIST_PATH = path.join(__dirname, "wordlist.json");

let cachedWordlist = null;
function loadWordlist() {
  if (cachedWordlist) return cachedWordlist;
  const raw = fs.readFileSync(WORDLIST_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  cachedWordlist = {
    profanity: (parsed.profanity || []).map((w) => String(w).toLowerCase()),
    scamPhrases: (parsed.scamPhrases || []).map((w) => String(w).toLowerCase()),
  };
  return cachedWordlist;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Runs the local wordlist check against arbitrary text (campaign name
 * and/or message body — callers pass whatever text needs checking).
 * Returns { flagged, matches: string[] } — matches is every distinct
 * term that hit, useful for the stored moderation_flags column and for
 * short-circuiting the Gemini call.
 */
export function checkWordlist(text) {
  const { profanity, scamPhrases } = loadWordlist();
  const lower = String(text || "").toLowerCase();
  const matches = [];

  for (const word of profanity) {
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
    if (re.test(lower)) matches.push(word);
  }
  for (const phrase of scamPhrases) {
    if (lower.includes(phrase)) matches.push(phrase);
  }

  return { flagged: matches.length > 0, matches };
}
