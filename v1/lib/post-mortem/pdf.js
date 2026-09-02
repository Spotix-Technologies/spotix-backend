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
import path from "path";
import { fileURLToPath } from "url";

// pdfkit's built-in "Helvetica" is a base-14 PDF font with WinAnsi
// encoding only — it has no glyph for "₦" (U+20A6), so money() calls
// were silently rendering as a notdef box/pipe character. Vendoring
// DejaVu Sans (same fix spotix-booker already applies for its own PDF
// reports — see app/lib/poll-results-pdf.ts and pdf-report-kit.ts over
// there) gives full glyph coverage. Unlike pdf-lib, pdfkit embeds TTFs
// natively via registerFont() — no separate fontkit package needed.
// Resolved relative to this file (not process.cwd()) since this runs as
// a Fastify service, not a Next.js app with a fixed project root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = path.join(__dirname, "fonts", "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "fonts", "DejaVuSans-Bold.ttf");

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

/** Pre-truncates `text` (at the doc's CURRENT font/fontSize) to fit
 *  `maxWidth`, appending an ellipsis if it had to cut. Measures with
 *  doc.widthOfString() and binary-searches the longest fitting prefix.
 *
 *  Every single-line field in this file used to rely on pdfkit's own
 *  `width` + `lineBreak: false` + `ellipsis: true` combo instead. That
 *  combo doesn't do what it looks like it does: `ellipsis` only actually
 *  activates when an explicit `height` option is *also* passed (never
 *  was, anywhere in this file) — so it silently never truncated anything.
 *  And `lineBreak: false` only stops wrapping *between* separate words;
 *  a single long unbreakable token (a full ticket reference like
 *  "SPTX-REF-1786429402528-VZ", a no-space email) that doesn't fit the
 *  column still gets force-split across multiple internal lines by
 *  pdfkit's word-wrapper regardless of that flag. Passing `width` at all
 *  routes text() through pdfkit's LineWrapper, and if one of those forced
 *  extra lines lands near the bottom of a page, LineWrapper silently
 *  starts a *real* new page mid-cell (doc.continueOnNewPage()) — which is
 *  exactly what was cutting references in half across a page boundary,
 *  compressing rows, and leaving the trailing blank pages: every table
 *  row after that point kept drawing against this file's own manually
 *  tracked `y`, which had no idea pdfkit had silently added a page out
 *  from under it.
 *
 *  Truncating here ourselves and then calling doc.text() with NO `width`
 *  option (see below) means the string is already guaranteed to render
 *  on one line, so none of that wrapping/pagination machinery ever runs —
 *  pdfkit takes the plain single-line path instead. */
function truncate(doc, text, maxWidth) {
  const str = String(text ?? "");
  if (maxWidth <= 0) return "";
  if (doc.widthOfString(str) <= maxWidth) return str;

  const ellipsis = "…";
  const ellipsisWidth = doc.widthOfString(ellipsis);
  if (ellipsisWidth > maxWidth) return "";

  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidateWidth = doc.widthOfString(str.slice(0, mid)) + ellipsisWidth;
    if (candidateWidth <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? str.slice(0, lo) + ellipsis : ellipsis;
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
  doc.fontSize(14).font("Body-Bold").fillColor(INK).text(text, PAGE_MARGIN, doc.y, {
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
    doc.fontSize(9).fillColor(MUTED).font("Body").text(emptyText, x, plotBottom / 2 + chartY / 2, {
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
      const labelWidth = barWidth + 20;
      doc.fontSize(6).fillColor(MUTED).font("Body");
      const fitted = truncate(doc, b.label, labelWidth);
      // Manual centering, no `width` passed to text() — see truncate()'s
      // comment for why `width` is avoided on pre-fitted single lines.
      const fittedWidth = doc.widthOfString(fitted);
      doc.text(fitted, bx - 10 + (labelWidth - fittedWidth) / 2, plotBottom + 4, { lineBreak: false });
    }
  });

  doc.fontSize(8).fillColor(INK).font("Body-Bold").text(`Peak: ${maxValue}`, x, chartY, {
    width,
    align: "right",
  });

  doc.restore();
  doc.y = chartY + height;
}

const CHART_PALETTE = [BRAND, "#16a34a", "#d97706", "#dc2626", "#0ea5e9", "#9333ea", "#64748b", "#0891b2"];

/** Single-choice (radio) question: a pie chart plus a text key of the
 *  form "Item A: 62%, Item B: 38%" underneath, as requested. Reserves its
 *  own space with ensureSpace and advances doc.y past everything it drew. */
function drawPieChart(doc, { segments, emptyText = "No responses yet" }) {
  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  const radius = 55;
  const chartHeight = radius * 2 + 14;
  const total = segments.reduce((s, seg) => s + seg.count, 0);

  if (total === 0) {
    ensureSpace(doc, 30);
    doc.fontSize(9).fillColor(MUTED).font("Body").text(emptyText, PAGE_MARGIN, doc.y, { width: contentWidth });
    doc.moveDown();
    return;
  }

  ensureSpace(doc, chartHeight + 8);
  const top = doc.y;
  const cx = PAGE_MARGIN + radius + 4;
  const cy = top + radius;

  doc.save();
  let startAngle = -Math.PI / 2;
  segments.forEach((seg, i) => {
    if (seg.count <= 0) return;
    const angle = (seg.count / total) * Math.PI * 2;
    const endAngle = startAngle + angle;
    const color = CHART_PALETTE[i % CHART_PALETTE.length];
    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    const largeArc = angle > Math.PI ? 1 : 0;
    doc.path(`M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`).fill(color);
    startAngle = endAngle;
  });
  doc.restore();

  // Legend to the right of the pie — flowed text (no explicit y per
  // line), so it advances doc.y normally and can page-break safely on
  // its own if the option list is long.
  const legendX = cx + radius + 24;
  const legendWidth = PAGE_MARGIN + contentWidth - legendX;
  doc.y = top;
  segments.forEach((seg, i) => {
    const color = CHART_PALETTE[i % CHART_PALETTE.length];
    const rowY = doc.y;
    doc.save().rect(legendX, rowY + 2, 8, 8).fill(color).restore();
    const label = truncate(doc, `${seg.label} — ${seg.pct}% (${seg.count})`, legendWidth - 14);
    doc.fillColor(INK).font("Body").fontSize(8).text(label, legendX + 14, rowY, { lineBreak: false });
    doc.y = rowY + 13;
  });

  doc.y = Math.max(doc.y, top + chartHeight);

  // The plain-text key, exactly the "Item A: x%, Item B: y%" format.
  const keyText = segments.map((seg) => `${seg.label}: ${seg.pct}%`).join(", ");
  doc.fontSize(8).font("Body-Oblique").fillColor(MUTED).text(keyText, PAGE_MARGIN, doc.y + 4, {
    width: contentWidth,
  });
  doc.moveDown(0.6);
}

/** Multi-choice (checkbox) question: one horizontal proportional bar per
 *  option, label at left (respondents can pick more than one option, so
 *  these percentages are of respondents and can sum past 100% — a pie
 *  would misrepresent that, hence a bar list instead). */
function drawChoiceBreakdown(doc, { segments, emptyText = "No responses yet" }) {
  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  const total = segments.reduce((s, seg) => s + seg.count, 0);

  if (total === 0) {
    ensureSpace(doc, 30);
    doc.fontSize(9).fillColor(MUTED).font("Body").text(emptyText, PAGE_MARGIN, doc.y, { width: contentWidth });
    doc.moveDown();
    return;
  }

  const labelWidth = 150;
  const barMaxWidth = contentWidth - labelWidth - 50;
  const rowHeight = 20;

  segments.forEach((seg, i) => {
    ensureSpace(doc, rowHeight);
    const rowY = doc.y;
    const color = CHART_PALETTE[i % CHART_PALETTE.length];
    doc.fillColor(INK).font("Body").fontSize(8);
    doc.text(truncate(doc, seg.label, labelWidth - 6), PAGE_MARGIN, rowY + 3, { lineBreak: false });

    const barX = PAGE_MARGIN + labelWidth;
    const barWidth = Math.max(2, (seg.pct / 100) * barMaxWidth);
    doc.save().rect(barX, rowY, barMaxWidth, 12).fill("#f1f5f9").restore();
    doc.save().rect(barX, rowY, barWidth, 12).fill(color).restore();
    doc.fillColor(MUTED).font("Body").fontSize(7.5);
    doc.text(`${seg.pct}% (${seg.count})`, barX + barMaxWidth + 6, rowY + 3, { lineBreak: false });

    doc.y = rowY + rowHeight;
  });
}

function drawStatCard(doc, { x, y, width, label, value, accent = BRAND }) {
  const height = 54;
  doc.save();
  doc.roundedRect(x, y, width, height, 6).fillAndStroke("#ffffff", FAINT_BORDER);
  doc.rect(x, y, 4, height).fill(accent);
  doc.fillColor(MUTED).font("Body").fontSize(8).text(label, x + 14, y + 10, { width: width - 24 });
  doc.fillColor(INK).font("Body-Bold").fontSize(18).text(String(value), x + 14, y + 24, { width: width - 24 });
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

  // Pre-truncated via truncate(), then text() called with no `width` —
  // see that function's comment. This card's own fixed y-offsets per
  // field are why the old wrap-onto-a-second-line failure mode showed up
  // as visibly overlapping text (a wrapped title bleeding down into the
  // name row below it), even though it never triggered an actual page
  // break the way the table rows did.
  doc.fillColor(accent).font("Body-Bold").fontSize(8.5);
  doc.text(truncate(doc, title.toUpperCase(), textWidth), textX, y + 10, { characterSpacing: 0.3, lineBreak: false });
  doc.fillColor(INK).font("Body-Bold").fontSize(10);
  doc.text(truncate(doc, name || "Unknown", textWidth), textX, y + 24, { lineBreak: false });
  doc.fillColor(MUTED).font("Body").fontSize(7.5);
  doc.text(truncate(doc, email || "", textWidth), textX, y + 38, { lineBreak: false });
  if (detail) {
    doc.fillColor(accent).font("Body").fontSize(7.5);
    doc.text(truncate(doc, detail, textWidth), textX, y + 51, { lineBreak: false });
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
  doc.font("Body-Bold").fontSize(7.5).fillColor("#ffffff");
  headers.forEach((h, i) => {
    doc.text(truncate(doc, h, colWidths[i] - 8), cx + 5, y + 5.5, { lineBreak: false });
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
    doc.font("Body").fontSize(7).fillColor(INK);
    let cx = x;
    row.forEach((v, ci) => {
      // Pre-truncated, no `width` passed to text() — see truncate()'s
      // comment for why: that's what actually keeps this on one line and
      // off pdfkit's own pagination path, unlike the lineBreak/ellipsis
      // combo this used to rely on.
      doc.text(truncate(doc, v, colWidths[ci] - 8), cx + 5, y + 4, { lineBreak: false });
      cx += colWidths[ci];
    });
    y += rowHeight;
  });

  doc.y = y + 12;
}

export async function renderPostMortemPdf({ event, stats, surveyStats = [], generatedByName, generatedAt }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
      // Registered under our own names, NOT "Helvetica"/"Helvetica-Bold".
      // Overriding pdfkit's built-in standard-14 names with a custom TTF
      // "works" for plain ASCII but silently breaks non-ASCII glyphs
      // (confirmed: ₦ rendered fine under a custom font name, but as a
      // notdef box under a font registered as "Helvetica", even loading
      // the identical DejaVuSans.ttf file both times) — pdfkit special-
      // cases the base-14 names somewhere in its encoding path regardless
      // of registerFont(). Using distinct names sidesteps that entirely.
      doc.registerFont("Body", FONT_REGULAR);
      doc.registerFont("Body-Bold", FONT_BOLD);
      // No separate italic TTF vendored — DejaVu Sans doesn't do
      // synthetic oblique, so this just maps to the same regular face
      // rather than pulling in a fourth font file for one line of text.
      doc.registerFont("Body-Oblique", FONT_REGULAR);
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const contentWidth = doc.page.width - PAGE_MARGIN * 2;

      // ── Cover / header ──
      doc.rect(0, 0, doc.page.width, 120).fill(BRAND);
      doc.fillColor("#ffffff").font("Body-Bold").fontSize(22).text(
        `Attendee Post Mortem Data for ${event.eventName}`,
        PAGE_MARGIN,
        40,
        { width: contentWidth }
      );
      const generatedLine = generatedByName
        ? `Generated by ${generatedByName} on ${fmtDateTime(generatedAt || new Date())}`
        : `Generated ${fmtDateTime(generatedAt || new Date())}`;
      doc.font("Body").fontSize(10).fillColor("#e9d8fd").text(
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
        doc.fontSize(9).font("Body").fillColor(MUTED).text(
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
        doc.fillColor("#c2410c").font("Body-Bold").fontSize(10).text(
          "No attendees checked in",
          PAGE_MARGIN,
          doc.y + 14,
          { width: contentWidth, align: "center" }
        );
        doc.y += 50;
      } else {
        doc.fontSize(9).font("Body").fillColor(MUTED).text(
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

      // ── Revenue ──
      // Organizers see what their event generated — not Spotix's cut, so
      // this is a single figure (sum of each ticket's own ticketPrice; see
      // data.js#ticketPriceOf and stats.js's revenue block) rather than a
      // Gross/Fees/Net breakdown that would expose the transaction fee.
      sectionTitle(doc, "Revenue");
      ensureSpace(doc, 54 + 10); // whole card row must land on one page — see ensureSpace() note below
      const revCardY = doc.y;
      drawStatCard(doc, {
        x: PAGE_MARGIN,
        y: revCardY,
        width: contentWidth,
        label: "Total Revenue Generated",
        value: money(stats.revenue.totalRevenue),
        accent: "#16a34a",
      });
      doc.y = revCardY + 54 + 10;

      // ── Referrals & discounts ──
      sectionTitle(doc, "Referrals & Discounts");
      const acqCardGap = 12;
      const acqCardWidth = (contentWidth - acqCardGap * 2) / 3;
      // Without this, drawStatCard()'s absolute-positioned .text() calls
      // can land close enough to the page bottom that pdfkit silently
      // starts a new page mid-card (see continueOnNewPage() note up top) —
      // that's what scattered "Gross Sales" / "Transaction Fees" / "Net
      // Ticket Value" across three different pages instead of one row.
      // Reserving the row's full height up front forces the whole row
      // onto a single page.
      ensureSpace(doc, 54 + 14);
      const acqCardY = doc.y;
      drawStatCard(doc, {
        x: PAGE_MARGIN,
        y: acqCardY,
        width: acqCardWidth,
        label: "Used a Discount",
        value: `${stats.acquisition.discountCount} (${stats.acquisition.discountPct}%)`,
      });
      drawStatCard(doc, {
        x: PAGE_MARGIN + acqCardWidth + acqCardGap,
        y: acqCardY,
        width: acqCardWidth,
        label: "Came via Referral",
        value: `${stats.acquisition.referralCount} (${stats.acquisition.referralPct}%)`,
        accent: "#0ea5e9",
      });
      drawStatCard(doc, {
        x: PAGE_MARGIN + (acqCardWidth + acqCardGap) * 2,
        y: acqCardY,
        width: acqCardWidth,
        label: "Organic (Neither)",
        value: `${stats.acquisition.organicCount} (${stats.acquisition.organicPct}%)`,
        accent: "#64748b",
      });
      doc.y = acqCardY + 54 + 14;

      if (stats.acquisition.topDiscountCodes.length > 0) {
        doc.fontSize(9).font("Body-Bold").fillColor(INK).text("Discount codes used:", PAGE_MARGIN, doc.y, { width: contentWidth });
        doc.moveDown(0.3);
        stats.acquisition.topDiscountCodes.forEach((d) => {
          ensureSpace(doc, 12);
          doc.fontSize(8.5).font("Body").fillColor(MUTED).text(`${d.code} — ${d.count} ticket${d.count === 1 ? "" : "s"}`, PAGE_MARGIN, doc.y, {
            width: contentWidth,
          });
        });
        doc.moveDown(0.6);
      }

      if (stats.acquisition.topReferrers.length > 0) {
        doc.fontSize(9).font("Body-Bold").fillColor(INK).text("Top referrers:", PAGE_MARGIN, doc.y, { width: contentWidth });
        doc.moveDown(0.3);
        stats.acquisition.topReferrers.forEach((r) => {
          ensureSpace(doc, 12);
          doc.fontSize(8.5).font("Body").fillColor(MUTED).text(`${r.label} — ${r.count} ticket${r.count === 1 ? "" : "s"}`, PAGE_MARGIN, doc.y, {
            width: contentWidth,
          });
        });
        doc.moveDown(0.6);
      }

      // ── Survey responses (only if the organizer set up a form) ──
      if (surveyStats.length > 0) {
        sectionTitle(doc, "Survey Responses");
        surveyStats.forEach((q) => {
          ensureSpace(doc, 30);
          doc.fontSize(11).font("Body-Bold").fillColor(INK).text(q.questionText, PAGE_MARGIN, doc.y, { width: contentWidth });
          doc.fontSize(7.5).font("Body").fillColor(MUTED).text(`${q.answeredCount} response${q.answeredCount === 1 ? "" : "s"}`, PAGE_MARGIN, doc.y, {
            width: contentWidth,
          });
          doc.moveDown(0.4);

          if (q.kind === "single-choice") {
            drawPieChart(doc, { segments: q.segments });
          } else if (q.kind === "multi-choice") {
            drawChoiceBreakdown(doc, { segments: q.segments });
            doc.moveDown(0.4);
          } else if (q.entries.length === 0) {
            doc.fontSize(9).font("Body").fillColor(MUTED).text("No responses yet", PAGE_MARGIN, doc.y, { width: contentWidth });
            doc.moveDown(0.6);
          } else {
            q.entries.forEach((entry) => {
              ensureSpace(doc, 14);
              doc.fontSize(8.5).font("Body-Bold").fillColor(INK);
              doc.text(truncate(doc, entry.fullName, 150), PAGE_MARGIN, doc.y, { continued: true, lineBreak: false });
              doc.font("Body").fillColor(MUTED).text(`  —  ${entry.answer}`, { width: contentWidth - 150 });
            });
            doc.moveDown(0.5);
          }
        });
      }

      // ── Full attendee timeline ──
      sectionTitle(doc, "Complete Attendee Timeline");
      renderTable(doc, {
        headers: ["Reference", "Name", "Email", "Ticket Type", "Purchased", "Ticket Price", "Checked In"],
        colWidths: colWidthsFromRatios(contentWidth, [0.14, 0.15, 0.24, 0.11, 0.15, 0.11, 0.1]),
        rows: stats.fullTimelineForTable.map((a) => [
          a.ticketReference,
          a.fullName,
          a.email,
          a.ticketType,
          a.purchaseDate ? fmtDateTime(a.purchaseDate) : "Unknown",
          // Each ticket's own price (data.js#ticketPriceOf) — not the
          // shared order total, which would show the same amount for
          // every ticket in a multi-ticket purchase.
          typeof a.ticketPrice === "number" ? money(a.ticketPrice) : "—",
          a.verified ? "Yes" : "No",
        ]),
      });

      // ── Footer page numbers ──
      // Deliberately drawn at page.height - 30, inside the bottom margin
      // (margins.bottom is 50, so maxY = height - 50 — this y is below
      // that on purpose, in the margin whitespace). Passing `width` here
      // used to route it through LineWrapper, whose very first check is
      // "does document.y already exceed maxY?" — it does, by design, so
      // every single footer stamp was silently triggering
      // continueOnNewPage() and appending a brand-new blank page at the
      // *end* of the document instead of stamping the page it was
      // switched to. That's what was doubling the real page count (a
      // content page bleeding "of 6" onto what a reader sees as 12
      // pages) — this was happening on top of, and independently of, the
      // reference-truncation bug above. No `width` here for the same
      // reason as truncate()'s other call sites: manually measure and
      // center instead, so this never goes through LineWrapper at all.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const footerText = `Spotix • Attendee Post Mortem • Page ${i - range.start + 1} of ${range.count}`;
        doc.fontSize(7.5).fillColor(MUTED).font("Body");
        const footerWidth = doc.widthOfString(footerText);
        doc.text(footerText, PAGE_MARGIN + (contentWidth - footerWidth) / 2, doc.page.height - 30, { lineBreak: false });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
