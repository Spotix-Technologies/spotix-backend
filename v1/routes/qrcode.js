// v1/routes/qrcode.js
//
// GET /v1/qrcode/:ticketId.png        -> 300px PNG (default)
// GET /v1/qrcode/:ticketId.png?size=X -> custom pixel size (128-1000)
//
// Fastify route wiring only — see v1/controllers/qrcode.controller.js
// for the actual QR rendering.

import { getTicketQrCode } from "../controllers/qrcode.controller.js";

export default async function qrCodeRoute(fastify, options) {
  fastify.get("/qrcode/:ticketId", getTicketQrCode);
}
