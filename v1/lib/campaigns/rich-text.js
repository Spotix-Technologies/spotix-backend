/**
 * v1/lib/campaigns/rich-text.js
 *
 * Turns the organizer's plain-text message into safe, inline-styled
 * HTML for email clients. The organizer NEVER submits HTML — only this
 * small, deliberate markup subset — so there's no way to inject
 * arbitrary markup through a campaign message (same guarantee the old
 * bold-only formatMessage had, just extended):
 *
 *   **bold**            → <strong>
 *   _italic_             → <em>
 *   --underline--        → <span style="text-decoration:underline">
 *   [text](https://url)  → <a> (http/https only, everything else is
 *                           left as literal text)
 *   - item                (one per line) → <ul><li>
 *   1. item                              → <ol><li>
 *   [center]...[/center]  → <div style="text-align:center">
 *   [right]...[/right]    → <div style="text-align:right">
 *   [left]...[/left]      → <div style="text-align:left"> (default anyway)
 *   blank line            → paragraph break
 *   single newline        → <br/>
 *
 * spotix-booker's app/lib/campaign-rich-text.ts is a hand-mirrored copy
 * of this exact file, used only for the Design step's instant client-
 * side preview — there's no shared package between the two repos (see
 * that file's header comment). If this file changes, that one needs
 * updating to match, or the live preview will silently drift from what
 * actually gets sent.
 */

export function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ALIGN_RE = /\[(center|right|left)\]([\s\S]*?)\[\/\1\]/g;
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BOLD_RE = /\*\*(.+?)\*\*/g;
const UNDERLINE_RE = /--(.+?)--/g;
const ITALIC_RE = /_(.+?)_/g;
const UL_LINE_RE = /^-\s+(.*)$/;
const OL_LINE_RE = /^\d+\.\s+(.*)$/;

/** Inline formatting only — links, bold, underline, italic. Applied to
 *  already-HTML-escaped text (so &, <, >, " are already entities and
 *  none of these regexes need to worry about them). */
function styleSpans(text) {
  return text
    .replace(BOLD_RE, "<strong>$1</strong>")
    .replace(UNDERLINE_RE, '<span style="text-decoration:underline;">$1</span>')
    .replace(ITALIC_RE, "<em>$1</em>");
}

function inlineFormat(text) {
  // Links are pulled out into placeholders first so bold/italic/
  // underline markers inside a URL (e.g. https://x.com/a_b_c) can't be
  // misread as formatting and corrupt the href.
  const links = [];
  const withTokens = text.replace(LINK_RE, (_, label, url) => {
    links.push(`<a href="${url}" style="color:inherit;text-decoration:underline;">${styleSpans(label)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  return styleSpans(withTokens).replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
}

/** Paragraphs + lists for one segment of text (everything between, or
 *  outside of, alignment blocks). */
function renderBlock(segment) {
  const lines = segment.split("\n");
  let html = "";
  let paraBuf = [];
  let listBuf = [];
  let listType = null; // "ul" | "ol" | null

  function flushPara() {
    const text = paraBuf.join("\n").trim();
    paraBuf = [];
    if (!text) return;
    html += `<p style="margin:0 0 14px;">${inlineFormat(text).replace(/\n/g, "<br/>")}</p>`;
  }

  function flushList() {
    if (!listBuf.length) return;
    const items = listBuf.map((item) => `<li style="margin:0 0 6px;">${inlineFormat(item)}</li>`).join("");
    html += listType === "ol"
      ? `<ol style="margin:0 0 14px;padding-left:20px;">${items}</ol>`
      : `<ul style="margin:0 0 14px;padding-left:20px;">${items}</ul>`;
    listBuf = [];
    listType = null;
  }

  for (const line of lines) {
    const ulMatch = UL_LINE_RE.exec(line);
    const olMatch = !ulMatch && OL_LINE_RE.exec(line);

    if (ulMatch) {
      if (paraBuf.length) flushPara();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listBuf.push(ulMatch[1]);
    } else if (olMatch) {
      if (paraBuf.length) flushPara();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listBuf.push(olMatch[1]);
    } else if (line.trim() === "") {
      if (listType) flushList();
      flushPara();
    } else {
      if (listType) flushList();
      paraBuf.push(line);
    }
  }
  flushList();
  flushPara();
  return html;
}

/** Splits on [center]/[right]/[left] blocks, running renderBlock on
 *  everything in between and inside them. */
function renderWithAlignment(text) {
  let html = "";
  let lastIndex = 0;
  let match;
  ALIGN_RE.lastIndex = 0;
  while ((match = ALIGN_RE.exec(text))) {
    html += renderBlock(text.slice(lastIndex, match.index));
    const align = match[1];
    const inner = renderBlock(match[2]);
    html += `<div style="text-align:${align};">${inner}</div>`;
    lastIndex = ALIGN_RE.lastIndex;
  }
  html += renderBlock(text.slice(lastIndex));
  return html;
}

/** Plain text only, in from the organizer — escape first, then apply
 *  the safe markup subset described above. */
export function formatMessage(messageText) {
  const escaped = escapeHtml(messageText);
  return renderWithAlignment(escaped);
}
