// v1/controllers/qrcode.controller.js
//
// Self-hosted ticket QR code rendering, extracted from the old
// v1/qrcode.js so the route file (v1/routes/qrcode.js) is just Fastify
// wiring.

import QRCode from "qrcode";

// Ticket IDs look like SPTX-TX-XXXXXXXX, agent passes may differ slightly —
// keep this permissive (letters/digits/dashes/underscores only) so it
// covers both, while still blocking anything that isn't a plausible ID.
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

export async function getTicketQrCode(request, reply) {
  // Accept both /qrcode/SPTX-TX-123 and /qrcode/SPTX-TX-123.png
  const rawParam = String(request.params.ticketId || "").trim();
  const ticketId = rawParam.endsWith(".png") ? rawParam.slice(0, -4) : rawParam;

  const { size } = request.query || {};
  const pixelSize = Math.min(Math.max(Number(size) || 300, 128), 1000);

  if (!ticketId || !SAFE_ID_PATTERN.test(ticketId)) {
    return reply.code(400).send({ error: "Invalid or missing ticketId" });
  }

  try {
    const pngBuffer = await QRCode.toBuffer(ticketId, {
      type: "png",
      width: pixelSize,
      margin: 1,
      errorCorrectionLevel: "M",
      color: {
        dark: "#3d2c5e", // brand ink — reads fine on white/light backgrounds
        light: "#ffffff",
      },
    });

    reply.header("Content-Type", "image/png");
    // Deterministic per ticketId+size — safe to cache hard, including in
    // email clients' image proxies (Gmail, etc).
    reply.header("Cache-Control", "public, max-age=604800, immutable");
    return reply.send(pngBuffer);
  } catch (error) {
    request.log.error(`[qrcode] failed to render QR for ticketId "${ticketId}":`, error);
    return reply.code(500).send({ error: "Failed to generate QR code" });
  }
}
