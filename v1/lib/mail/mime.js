// v1/lib/mail/mime.js
//
// Minimal MIME builder for emails with attachments. AWS SES's SendEmail API
// (what ses-client.js uses for plain emails) can't carry attachments — that
// needs SendRawEmail with a hand-built message. Kept dependency-free: the
// structure is always
//
//   multipart/mixed
//     ├─ multipart/alternative   (text/plain + text/html)
//     └─ one part per attachment (base64)
//
// Only used when an email actually has attachments; every other email keeps
// going through SendEmail untouched.

import { randomBytes } from "crypto";

const CRLF = "\r\n";

/** Header values must never contain line breaks (header injection). */
const clean = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

/** RFC 2047 encoded-word for non-ASCII header text (Subject etc.). */
function encodeHeaderText(value) {
  const v = clean(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

const wrap76 = (b64) => (b64.match(/.{1,76}/g) || []).join(CRLF);
const b64 = (input) => wrap76(Buffer.from(input).toString("base64"));
const boundary = (tag) => `----=_Spotix_${tag}_${randomBytes(12).toString("hex")}`;

/**
 * @param {Object} p
 * @param {string} p.from - "Display Name <address@domain>"
 * @param {string} p.to
 * @param {string} p.subject
 * @param {string} p.html
 * @param {string} [p.text] - plain-text alternative
 * @param {{ filename: string, contentType: string, content: Buffer|string }[]} [p.attachments]
 * @returns {Buffer} the full RFC 5322 message
 */
export function buildRawEmail({ from, to, subject, html, text, attachments = [] }) {
  const mixed = boundary("mixed");
  const alt = boundary("alt");

  const head = [
    `From: ${clean(from)}`,
    `To: ${clean(to)}`,
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ].join(CRLF);

  const body = [];

  body.push(`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "");
  if (text) {
    body.push(
      `--${alt}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64(text)
    );
  }
  body.push(
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(html),
    `--${alt}--`,
    ""
  );

  for (const a of attachments) {
    const name = clean(a.filename).replace(/"/g, "");
    body.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType}; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`,
      "",
      b64(a.content),
      ""
    );
  }
  body.push(`--${mixed}--`, "");

  return Buffer.from(head + CRLF + CRLF + body.join(CRLF), "utf8");
}
