// v1/dicebear.js
//
// Self-hosted Dicebear avatars. Generates the SVG locally via
// @dicebear/core + @dicebear/collection — no request ever leaves this
// server, unlike using https://api.dicebear.com directly.
//
// GET /v1/dicebear/:seed              -> avataaars style (default)
// GET /v1/dicebear/:seed?style=X      -> style = avataaars | micah | identicon
// GET /v1/dicebear/:seed?size=96      -> pixel size (default 128)
//
// Requires: npm install @dicebear/core @dicebear/collection
// See README-dicebear.md alongside this file for full setup notes.

import { createAvatar } from "@dicebear/core"
import { avataaars, micah, identicon } from "@dicebear/collection"

const STYLES = { avataaars, micah, identicon }

export default async function dicebearRoute(fastify, options) {
  fastify.get("/dicebear/:seed", async (request, reply) => {
    const { seed } = request.params
    const { style = "avataaars", size } = request.query || {}

    if (!seed) {
      return reply.code(400).send({ error: "seed is required" })
    }

    const collection = STYLES[style] || STYLES.avataaars

    try {
      const avatar = createAvatar(collection, {
        // Fastify already URL-decodes route params and we are na decoding again here
        // would double-decode (breaks on a literal "%" in the seed, and
        // throws URIError -> 500 for anything malformed).
        seed: String(seed).trim().toLowerCase(),
        size: Number(size) > 0 ? Number(size) : 128,
      })
      const svg = avatar.toString()

      reply.header("Content-Type", "image/svg+xml; charset=utf-8")
      // Deterministic output for a given seed+style — safe to cache hard.
      reply.header("Cache-Control", "public, max-age=604800, immutable")
      return reply.send(svg)
    } catch (error) {
      fastify.log.error(`[dicebear] failed to render avatar for seed "${seed}":`, error)
      return reply.code(500).send({ error: "Failed to generate avatar" })
    }
  })
}
