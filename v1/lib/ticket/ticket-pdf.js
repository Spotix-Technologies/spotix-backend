// v1/lib/ticket/ticket-pdf.js
//
// Renders the "ticket.pdf" attached to ticket emails: one A5 page per
// physical ticket (so each can be printed or forwarded on its own), each
// with the event details and the ticket's QR — encoded with the raw
// ticketId, exactly like the self-hosted PNG in v1/controllers/qrcode.controller.js,
// so the door scanner reads the PDF and the inline email QR identically.
//
// Pure pdfkit + qrcode (both already dependencies — see
// v1/lib/post-mortem/pdf.js and the qrcode controller). Reuses the DejaVu
// fonts vendored for the post-mortem PDF: pdfkit's built-in Helvetica has no
// glyph for "₦" or accented characters in event names. Falls back to
// Helvetica if the font files are ever missing, so a font problem can't
// block ticket delivery.

import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, "..", "post-mortem", "fonts");
const FONT_REGULAR_FILE = path.join(FONT_DIR, "DejaVuSans.ttf");
const FONT_BOLD_FILE = path.join(FONT_DIR, "DejaVuSans-Bold.ttf");

const BRAND = "#6b2fa5";
const BRAND_LIGHT = "#9b59d6";
const BRAND_SOFT = "#faf5ff";
const BRAND_BORDER = "#e9d5ff";
const INK = "#3d2c5e";
const MUTED = "#6b7280";

// A5 portrait, in points
const PAGE_W = 419.53;
const PAGE_H = 595.28;
const PAD = 32;
const CONTENT_W = PAGE_W - PAD * 2;

/**
 * @param {Object} p
 * @param {{ ticketId: string, ticketType?: string }[]} p.tickets
 * @param {string} p.eventName
 * @param {string} [p.eventHost]
 * @param {string} [p.eventVenue]
 * @param {string} [p.eventWhen] - pre-formatted date/time line (see calendar-invite.js formatEventWhen)
 * @param {string} [p.holderName]
 * @param {string} [p.paymentRef]
 * @param {string} [p.supportEmail]
 * @returns {Promise<Buffer>}
 */
export async function buildTicketsPdf({
  tickets,
  eventName,
  eventHost,
  eventVenue,
  eventWhen,
  holderName,
  paymentRef,
  supportEmail = "support@spotix.com.ng",
}) {
  if (!tickets?.length) throw new Error("buildTicketsPdf: no tickets to render");

  // QR PNGs first (async) so the drawing loop below stays synchronous.
  const qrBuffers = await Promise.all(
    tickets.map((t) =>
      QRCode.toBuffer(String(t.ticketId), {
        type: "png",
        width: 480,
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: INK, light: "#ffffff" },
      })
    )
  );

  const hasFonts = fs.existsSync(FONT_REGULAR_FILE) && fs.existsSync(FONT_BOLD_FILE);

  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margin: 0,
    autoFirstPage: false,
    info: { Title: `${eventName} — ticket${tickets.length > 1 ? "s" : ""}`, Author: "Spotix Tickets" },
  });
  if (hasFonts) {
    doc.registerFont("Regular", FONT_REGULAR_FILE);
    doc.registerFont("Bold", FONT_BOLD_FILE);
  }
  const REGULAR = hasFonts ? "Regular" : "Helvetica";
  const BOLD = hasFonts ? "Bold" : "Helvetica-Bold";

  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  /** One label + value block; returns the y where the next block starts. Value is capped to `maxLines` with an ellipsis. */
  const field = (label, value, y, maxLines = 2) => {
    if (!value) return y;
    doc.font(BOLD).fontSize(7.5).fillColor(BRAND_LIGHT).text(label.toUpperCase(), PAD, y, { width: CONTENT_W, characterSpacing: 0.8, lineBreak: false });
    doc.font(REGULAR).fontSize(11);
    const lineH = doc.currentLineHeight();
    const h = Math.min(doc.heightOfString(String(value), { width: CONTENT_W }), lineH * maxLines);
    doc.fillColor(INK).text(String(value), PAD, y + 12, { width: CONTENT_W, height: lineH * maxLines, ellipsis: true });
    return y + 12 + h + 12;
  };

  tickets.forEach((ticket, i) => {
    doc.addPage();

    // ── Header band: brand + event name ──
    doc.rect(0, 0, PAGE_W, 128).fill(BRAND);
    doc.font(BOLD).fontSize(10).fillColor("#ffffff").text("SPOTIX", PAD, 24, { characterSpacing: 2, lineBreak: false });
    doc.font(REGULAR).fontSize(9).fillColor("#e9d5ff").text("E-TICKET", PAD, 25, { width: CONTENT_W, align: "right", characterSpacing: 1.5, lineBreak: false });
    doc.font(BOLD).fontSize(20);
    const nameLineH = doc.currentLineHeight();
    doc.fillColor("#ffffff").text(String(eventName), PAD, 52, { width: CONTENT_W, height: nameLineH * 2, ellipsis: true });

    // ── Details ──
    let y = 150;
    y = field("Date & time", eventWhen, y, 2);
    y = field("Venue", eventVenue, y, 2);
    y = field("Organised by", eventHost, y, 1);

    // ── Tear line with notches ──
    const tearY = Math.max(y + 2, 284);
    doc.save().lineWidth(1).dash(4, { space: 3 }).strokeColor(BRAND_BORDER).moveTo(PAD + 10, tearY).lineTo(PAGE_W - PAD - 10, tearY).stroke().restore();
    doc.circle(0, tearY, 11).fill("#f0eaf8");
    doc.circle(PAGE_W, tearY, 11).fill("#f0eaf8");

    // ── QR + ticket identity ──
    const qrSize = 150;
    const qrX = (PAGE_W - qrSize) / 2;
    const qrY = tearY + 20;
    doc.roundedRect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 10).lineWidth(1.2).fillAndStroke(BRAND_SOFT, BRAND_BORDER);
    doc.image(qrBuffers[i], qrX, qrY, { width: qrSize, height: qrSize });

    let ty = qrY + qrSize + 22;
    doc.font(BOLD).fontSize(13).fillColor(INK).text(String(ticket.ticketId), PAD, ty, { width: CONTENT_W, align: "center", lineBreak: false });
    ty += 19;
    const typeLine = `${ticket.ticketType || "Standard"}${tickets.length > 1 ? `  ·  Ticket ${i + 1} of ${tickets.length}` : ""}`;
    doc.font(REGULAR).fontSize(10).fillColor(MUTED).text(typeLine, PAD, ty, { width: CONTENT_W, height: 14, align: "center", ellipsis: true });
    if (holderName) {
      ty += 15;
      doc.font(REGULAR).fontSize(10).fillColor(MUTED).text(`Admit one · ${holderName}`, PAD, ty, { width: CONTENT_W, height: 14, align: "center", ellipsis: true });
    }

    // ── Footer ──
    doc.font(REGULAR).fontSize(8).fillColor(MUTED).text(
      "Show this QR code at the entrance. Each ticket is valid for one entry.",
      PAD, PAGE_H - 42, { width: CONTENT_W, align: "center", lineBreak: false }
    );
    doc.fontSize(7.5).fillColor("#9ca3af").text(
      `${paymentRef ? `Ref: ${paymentRef}  ·  ` : ""}${supportEmail}`,
      PAD, PAGE_H - 28, { width: CONTENT_W, height: 10, align: "center", ellipsis: true }
    );
  });

  doc.end();
  return done;
}
