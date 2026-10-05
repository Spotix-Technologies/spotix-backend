// v1/routes/dicebear.js
//
// GET /v1/dicebear/:seed              -> avataaars style (default)
// GET /v1/dicebear/:seed?style=X      -> style = avataaars | micah | identicon
// GET /v1/dicebear/:seed?size=96      -> pixel size (default 128)
//
// Fastify route wiring only — see v1/controllers/dicebear.controller.js
// for the actual avatar rendering.

import { getDicebearAvatar } from "../controllers/dicebear.controller.js";

export default async function dicebearRoute(fastify, options) {
  fastify.get("/dicebear/:seed", getDicebearAvatar);
}
