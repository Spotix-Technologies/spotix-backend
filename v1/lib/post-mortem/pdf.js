// v1/lib/post-mortem/pdf.js
//
// Renders the Attendee Post Mortem PDF from computed stats. Pure pdfkit —
// no headless browser, no Chromium dependency, so this runs fine on a
// small Render instance. Charts are hand-drawn with pdfkit's own vector
// primitives (rects/lines) rather than pulling in a charting library.
//
// Requires: npm install pdfkit svg-to-pdfkit
// (Dicebear's @dicebear/core + @dicebear/collection are already a
// dependency — see v1/dicebear.js.)

import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { createAvatar } from "@dicebear/core";
import { micah } from "@dicebear/collection";

const BRAND = "#6b2fa5";
const BRAND_LIGHT = "#f9f5ff";
const BRAND_BORDER = "#e9d8fd";
const INK = "#1e293b";
const MUTED = "#64748b";
const FAINT_BORDER = "#e2e8f0";

const PAGE_MARGIN = 50;

function money(n) {
  return `₦${Number(n || 0).toLocaleString("en-NG")}`;
}

function fmtDateTime(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Draws a Dicebear "micah" avatar (SVG, generated in-process — no
 *  outbound request) into a square of `size` at (x, y). Best-effort: a
 *  failed avatar just leaves a blank square rather than breaking the PDF. */
function embedAvatar(doc, seed, x, y, size) {
  try {
    const avatar = createAvatar(micah, { seed: String(seed || "unknown").trim().toLowerCase(), size: 64 });
    const svg = avatar.toString();
    SVGtoPDF(doc, svg, x, y, { width: size, height: size, preserveAspectRatio: "xMidYMid meet" });
  } catch {
    doc.save().roundedRect(x, y, size, size, 4).fill("#e2e8f0").restore();
  }
}

function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

function sectionTitle(doc, text) {
  ensureSpace(doc, 40);
  doc.moveDown(0.8);
  doc.fontSize(14).font("Helvetica-Bold").fillColor(INK).text(text, PAGE_MARGIN, doc.y, {
    width: doc.page.width - PAGE_MARGIN * 2,
  });
  doc.moveTo(PAGE_MARGIN, doc.y + 4).lineTo(doc.page.width - PAGE_MARGIN, doc.y + 4).strokeColor(BRAND_BORDER).lineWidth(1).stroke();
  doc.moveDown(0.6);
}

/** Simple bar chart. `buckets`: [{label, value}]. Returns nothing — draws
 *  in place starting at doc.y and advances doc.y past the chart. */
function drawBarChart(doc, { buckets, color = BRAND, emptyText = "No data available" }) {
  const width = doc.page.width - PAGE_MARGIN * 2;
  const height = 130;
  const x = PAGE_MARGIN;
  const y = doc.y;

  ensureSpace(doc, height + 20);
  const chartY = doc.y;
  const plotBottom = chartY + height - 20;

  doc.save();
  doc.lineWidth(1).strokeColor(FAINT_BORDER);
  doc.moveTo(x, plotBottom).lineTo(x + width, plotBottom).stroke();

  const hasData = buckets && buckets.length > 0 && buckets.some((b) => b.value > 0);
  if (!hasData) {
    doc.fontSize(9).fillColor(MUTED).font("Helvetica").text(emptyText, x, plotBottom / 2 + chartY / 2, {
      width,
      align: "center",
    });
    doc.restore();
    doc.y = chartY + height;
    return;
  }

  const maxValue = Math.max(...buckets.map((b) => b.value), 1);
  const n = buckets.length;
  const gap = n > 1 ? Math.min(6, (width / n) * 0.25) : 0;
  const barWidth = Math.max(2, (width - gap * (n - 1)) / n);
  const plotHeight = height - 20;

  const minLabelSpacing = 30;
  const labelStep = Math.max(1, Math.ceil(minLabelSpacing / (barWidth + gap)));

  buckets.forEach((b, i) => {
    const bx = x + i * (barWidth + gap);
    const barHeight = (b.value / maxValue) * (plotHeight - 4);
    const by = plotBottom - barHeight;
    doc.rect(bx, by, barWidth, Math.max(barHeight, 0.5)).fill(color);

    if (i % labelStep === 0 || i === n - 1) {
      doc.fontSize(6).fillColor(MUTED).font("Helvetica").text(b.label, bx - 10, plotBottom + 4, {
        width: barWidth + 20,
        align: "center",
      });
    }
  });

  doc.fontSize(8).fillColor(INK).font("Helvetica-Bold").text(`Peak: ${maxValue}`, x, chartY, {
    width,
    align: "right",
  });

  doc.restore();
  doc.y = chartY + height;
}

function drawStatCard(doc, { x, y, width, label, value, accent = BRAND }) {
  const height = 54;
  doc.save();
  doc.roundedRect(x, y, width, height, 6).fillAndStroke("#ffffff", FAINT_BORDER);
  doc.rect(x, y, 4, height).fill(accent);
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label, x + 14, y + 10, { width: width - 24 });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text(String(value), x + 14, y + 24, { width: width - 24 });
  doc.restore();
}

function drawPersonCard(doc, { x, y, width, height = 78, title, name, email, detail, seed, accent = BRAND }) {
  doc.save();
  doc.roundedRect(x, y, width, height, 6).fillAndStroke(BRAND_LIGHT, BRAND_BORDER);

  const avatarSize = 36;
  const avatarX = x + 12;
  const avatarY = y + (height - avatarSize) / 2;
  embedAvatar(doc, seed, avatarX, avatarY, avatarSize);

  const textX = avatarX + avatarSize + 12;
  const textWidth = width - (textX - x) - 12;

  // lineBreak: false is what actually makes `ellipsis` truncate to a
  // single line — without it pdfkit just wraps onto a second line (since
  // no `height` is given), which then overlaps whichever field is drawn
  // next at its own fixed y-offset. That's the "smudged" overlapping text
  // seen on longer award titles/names (e.g. "Night Owl — latest purchase
  // time") — every fixed-position single-line field in this card needs it.
  doc.fillColor(accent).font("Helvetica-Bold").fontSize(8.5).text(title.toUpperCase(), textX, y + 10, {
    width: textWidth,
    characterSpacing: 0.3,
    lineBreak: false,
    ellipsis: true,
  });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(name || "Unknown", textX, y + 24, {
    width: textWidth,
    lineBreak: false,
    ellipsis: true,
  });
  doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(email || "", textX, y + 38, {
    width: textWidth,
    lineBreak: false,
    ellipsis: true,
  });
  if (detail) {
    doc.fillColor(accent).font("Helvetica").fontSize(7.5).text(detail, textX, y + 51, {
      width: textWidth,
      lineBreak: false,
      ellipsis: true,
    });
  }
  doc.restore();
}

/** Turns a set of proportions (any positive numbers, don't need to sum to
 *  1) into column widths that always sum to exactly `contentWidth` — so a
 *  table can never run past the page's right margin regardless of how
 *  many columns it has. Column widths used to be hardcoded pixel values
 *  that didn't add up to the actual content width (the "Complete Attendee
 *  Timeline" table overran it by ~55pt), which is what made that table
 *  look unaligned/cut off. */
function colWidthsFromRatios(contentWidth, ratios) {
  const total = ratios.reduce((a, b) => a + b, 0);
  return ratios.map((r) => (r / total) * contentWidth);
}

function drawTableHeader(doc, x, y, colWidths, headers) {
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  doc.save();
  doc.rect(x, y, totalWidth, 18).fill(BRAND);
  let cx = x;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#ffffff");
  headers.forEach((h, i) => {
    doc.text(h, cx + 5, y + 5.5, { width: colWidths[i] - 8, lineBreak: false, ellipsis: true });
    cx += colWidths[i];
  });
  doc.restore();
  return y + 18;
}

function renderTable(doc, { headers, colWidths, rows }) {
  const x = PAGE_MARGIN;
  ensureSpace(doc, 18 + 16);
  let y = drawTableHeader(doc, x, doc.y, colWidths, headers);

  rows.forEach((row, i) => {
    const rowHeight = 16;
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = drawTableHeader(doc, x, PAGE_MARGIN, colWidths, headers);
    }
    if (i % 2 === 1) {
      doc.save().rect(x, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill("#f8fafc").restore();
    }
    doc.font("Helvetica").fontSize(7).fillColor(INK);
    let cx = x;
    row.forEach((v, ci) => {
      // lineBreak: false forces a hard one-line truncation instead of
      // wrapping into the row below it — long values (full references
      // like "SPTX-REF-1786429402528-VZ", long emails) were previously
      // wrapping onto a second line inside a fixed 16pt row and bleeding
      // into the next row's text.
      doc.text(String(v ?? ""), cx + 5, y + 4, { width: colWidths[ci] - 8, lineBreak: false, ellipsis: true });
      cx += colWidths[ci];
    });
    y += rowHeight;
  });

  doc.y = y + 12;
}

export async function renderPostMortemPdf({ event, stats, generatedByName, generatedAt }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const contentWidth = doc.page.width - PAGE_MARGIN * 2;

      // ── Cover / header ──
      doc.rect(0, 0, doc.page.width, 120).fill(BRAND);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(22).text(
        `Attendee Post Mortem Data for ${event.eventName}`,
        PAGE_MARGIN,
        40,
        { width: contentWidth }
      );
      const generatedLine = generatedByName
        ? `Generated by ${generatedByName} on ${fmtDateTime(generatedAt || new Date())}`
        : `Generated ${fmtDateTime(generatedAt || new Date())}`;
      doc.font("Helvetica").fontSize(10).fillColor("#e9d8fd").text(
        `${generatedLine}${event.eventVenue ? ` • ${event.eventVenue}` : ""}`,
        PAGE_MARGIN,
        doc.y + 6,
        { width: contentWidth }
      );

      doc.y = 145;

      // ── Summary stat cards ──
      const cardGap = 12;
      const cardWidth = (contentWidth - cardGap * 2) / 3;
      const cardY = doc.y;
      drawStatCard(doc, { x: PAGE_MARGIN, y: cardY, width: cardWidth, label: "Total Attendees", value: stats.totalAttendees });
      drawStatCard(doc, {
        x: PAGE_MARGIN + cardWidth + cardGap,
        y: cardY,
        width: cardWidth,
        label: "Checked In",
        value: stats.checkedInCount,
        accent: "#16a34a",
      });
      drawStatCard(doc, {
        x: PAGE_MARGIN + (cardWidth + cardGap) * 2,
        y: cardY,
        width: cardWidth,
        label: "Not Checked In",
        value: stats.notCheckedInCount,
        accent: "#d97706",
      });
      doc.y = cardY + 54 + 10;

      // ── First & last buyer ──
      sectionTitle(doc, "How It Started, How It's Going");
      const personGap = 12;
      const personWidth = (contentWidth - personGap) / 2;
      const personY = doc.y;
      drawPersonCard(doc, {
        x: PAGE_MARGIN,
        y: personY,
        width: personWidth,
        title: "First to buy",
        name: stats.firstBuyer?.fullName,
        email: stats.firstBuyer?.email,
        detail: stats.firstBuyer ? fmtDateTime(stats.firstBuyer.purchaseDate) : "No purchases recorded",
        seed: stats.firstBuyer?.email,
      });
      drawPersonCard(doc, {
        x: PAGE_MARGIN + personWidth + personGap,
        y: personY,
        width: personWidth,
        title: "Last to buy",
        name: stats.lastBuyer?.fullName,
        email: stats.lastBuyer?.email,
        detail: stats.lastBuyer ? fmtDateTime(stats.lastBuyer.purchaseDate) : "No purchases recorded",
        seed: stats.lastBuyer?.email,
      });
      doc.y = personY + 78 + 8;

      // ── Purchase timeline chart ──
      sectionTitle(
        doc,
        stats.purchaseBucketGranularity === "hour" ? "Purchases by Hour" : "Purchases Over Time"
      );
      drawBarChart(doc, { buckets: stats.purchaseBuckets, color: BRAND, emptyText: "No ticket purchases recorded" });

      // ── Fun awards ──
      sectionTitle(doc, "Fun Facts");
      const awardCards = [];
      if (stats.hasCheckins) {
        awardCards.push({
          title: "Early Bird — first checked in",
          name: stats.earlyBird?.fullName,
          email: stats.earlyBird?.email,
          detail: fmtDateTime(stats.earlyBird?.checkedInAt),
          seed: stats.earlyBird?.email,
        });
        awardCards.push({
          title: "Crasher — last checked in",
          name: stats.crasher?.fullName,
          email: stats.crasher?.email,
          detail: fmtDateTime(stats.crasher?.checkedInAt),
          seed: stats.crasher?.email,
        });
      }
      if (stats.hoarder) {
        awardCards.push({
          title: "Hoarder — most tickets bought",
          name: stats.hoarder.fullName,
          email: stats.hoarder.email,
          detail: `${stats.hoarder.count} tickets`,
          seed: stats.hoarder.email,
        });
      }
      if (stats.nightOwl) {
        awardCards.push({
          title: "Night Owl — latest purchase time",
          name: stats.nightOwl.fullName,
          email: stats.nightOwl.email,
          detail: fmtDateTime(stats.nightOwl.purchaseDate),
          seed: stats.nightOwl.email,
        });
      }

      if (awardCards.length === 0) {
        doc.fontSize(9).font("Helvetica").fillColor(MUTED).text(
          "Not enough activity yet to hand out any awards.",
          PAGE_MARGIN,
          doc.y,
          { width: contentWidth }
        );
        doc.moveDown();
      } else {
        // Draw a full row (both columns) at a time, using a locally-tracked
        // `rowY` rather than reading doc.y back out mid-row. drawPersonCard
        // issues several doc.text(x, y, ...) calls with explicit
        // coordinates, and pdfkit still moves the shared cursor (doc.y) to
        // wherever that text ended up — so reading doc.y for the *second*
        // card's ensureSpace check picked up a stale/incorrect position left
        // over from drawing the *first* card, instead of the row's actual
        // starting y. That's what could strand one card of a pair alone at
        // the top of the next page (e.g. the "Night Owl" card rendering by
        // itself, overlapping its own title) while its row-mate stayed
        // behind. Computing space for the whole row once, before drawing
        // either card, avoids the shared-cursor pollution entirely.
        const awardGap = 12;
        const awardWidth = (contentWidth - awardGap) / 2;
        const cardHeight = 78;
        const rowAdvance = cardHeight + 10;

        for (let i = 0; i < awardCards.length; i += 2) {
          ensureSpace(doc, rowAdvance);
          const rowY = doc.y;
          drawPersonCard(doc, { x: PAGE_MARGIN, y: rowY, width: awardWidth, ...awardCards[i], accent: "#9333ea" });
          if (awardCards[i + 1]) {
            drawPersonCard(doc, {
              x: PAGE_MARGIN + awardWidth + awardGap,
              y: rowY,
              width: awardWidth,
              ...awardCards[i + 1],
              accent: "#9333ea",
            });
          }
          doc.y = rowY + rowAdvance;
        }
      }

      // ── Check-in overview ──
      sectionTitle(doc, "Check-In Overview");
      if (!stats.hasCheckins) {
        ensureSpace(doc, 40);
        doc.roundedRect(PAGE_MARGIN, doc.y, contentWidth, 40, 6).fillAndStroke("#fff7ed", "#fed7aa");
        doc.fillColor("#c2410c").font("Helvetica-Bold").fontSize(10).text(
          "No attendees checked in",
          PAGE_MARGIN,
          doc.y + 14,
          { width: contentWidth, align: "center" }
        );
        doc.y += 50;
      } else {
        doc.fontSize(9).font("Helvetica").fillColor(MUTED).text(
          `${stats.checkedInCount} of ${stats.totalAttendees} attendees checked in (${Math.round(
            (stats.checkedInCount / Math.max(stats.totalAttendees, 1)) * 100
          )}%).`,
          PAGE_MARGIN,
          doc.y,
          { width: contentWidth }
        );
        doc.moveDown(0.5);
        drawBarChart(doc, { buckets: stats.checkinBuckets, color: "#16a34a", emptyText: "No check-in data" });

        sectionTitle(doc, "Checked-In Attendees");
        renderTable(doc, {
          headers: ["Name", "Email", "Ticket Type", "Checked In At"],
          colWidths: colWidthsFromRatios(contentWidth, [0.26, 0.34, 0.18, 0.22]),
          rows: stats.checkinTimeline.map((a) => [a.fullName, a.email, a.ticketType, fmtDateTime(a.checkedInAt)]),
        });
      }

      // ── Full attendee timeline ──
      sectionTitle(doc, "Complete Attendee Timeline");
      renderTable(doc, {
        headers: ["Reference", "Name", "Email", "Ticket Type", "Purchased", "Checked In"],
        colWidths: colWidthsFromRatios(contentWidth, [0.14, 0.18, 0.28, 0.13, 0.17, 0.1]),
        rows: stats.fullTimelineForTable.map((a) => [
          a.ticketReference,
          a.fullName,
          a.email,
          a.ticketType,
          a.purchaseDate ? fmtDateTime(a.purchaseDate) : "Unknown",
          a.verified ? "Yes" : "No",
        ]),
      });

      // ── Footer page numbers ──
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(7.5).fillColor(MUTED).font("Helvetica").text(
          `Spotix • Attendee Post Mortem • Page ${i - range.start + 1} of ${range.count}`,
          PAGE_MARGIN,
          doc.page.height - 30,
          { width: contentWidth, align: "center" }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
