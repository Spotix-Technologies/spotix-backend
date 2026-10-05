// v1/controllers/dicebear.controller.js
//
// Self-hosted Dicebear avatar rendering, extracted from the old
// v1/dicebear.js so the route file (v1/routes/dicebear.js) is just
// Fastify wiring.

import { createAvatar } from "@dicebear/core";
import { avataaars, micah, identicon } from "@dicebear/collection";

const STYLES = { avataaars, micah, identicon };

export async function getDicebearAvatar(request, reply) {
  const { seed } = request.params;
  const { style = "avataaars", size } = request.query || {};

  if (!seed) {
    return reply.code(400).send({ error: "seed is required" });
  }

  const collection = STYLES[style] || STYLES.avataaars;

  try {
    const avatar = createAvatar(collection, {
      // Fastify already URL-decodes route params and decoding again here
      // would double-decode (breaks on a literal "%" in the seed, and
      // throws URIError -> 500 for anything malformed).
      seed: String(seed).trim().toLowerCase(),
      size: Number(size) > 0 ? Number(size) : 128,
    });
    const svg = avatar.toString();

    reply.header("Content-Type", "image/svg+xml; charset=utf-8");
    // Deterministic output for a given seed+style — safe to cache hard!.
    reply.header("Cache-Control", "public, max-age=604800, immutable");
    return reply.send(svg);
  } catch (error) {
    request.log.error(`[dicebear] failed to render avatar for seed "${seed}":`, error);
    return reply.code(500).send({ error: "Failed to generate avatar" });
  }
}
