// v1/routes/gemini-enhance.js
//
// POST /v1/enhance — Gemini-powered event description enhancement.
//
// NOT currently registered in server.js (see the note in
// v1/controllers/gemini-enhance.controller.js) — carried over
// unregistered exactly as found in the original codebase.
//
// Fastify route wiring only — see
// v1/controllers/gemini-enhance.controller.js for the actual logic.

import { enhanceEventDescription } from "../controllers/gemini-enhance.controller.js";

export default async function enhanceRoute(fastify, options) {
  fastify.post("/enhance", enhanceEventDescription);
}
