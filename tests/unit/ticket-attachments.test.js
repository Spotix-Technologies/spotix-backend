// tests/unit/ticket-attachments.test.js
//
// invite.ics, the raw MIME builder, and ticket.pdf — all pure functions, no mocks.

import { describe, it, expect } from "vitest";
import { buildCalendarInvite, formatEventWhen } from "../../v1/lib/ticket/calendar-invite.js";
import { buildRawEmail } from "../../v1/lib/mail/mime.js";
import { buildTicketsPdf } from "../../v1/lib/ticket/ticket-pdf.js";

const base = { uid: "evt1-SPTX-REF-1@spotix.com.ng", title: "DevFest Enugu 2026", location: "Enugu" };

describe("buildCalendarInvite", () => {
  it("converts Lagos wall-clock times to UTC (UTC+1)", () => {
    const ics = buildCalendarInvite({ ...base, eventDate: "2026-12-04", eventStart: "13:00", eventEndDate: "2026-12-05", eventEnd: "18:00" });
    expect(ics).toContain("DTSTART:20261204T120000Z");
    expect(ics).toContain("DTEND:20261205T170000Z");
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("LOCATION:Enugu");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("defaults to a 3h duration when there is a start time but no end time", () => {
    const ics = buildCalendarInvite({ ...base, eventDate: "2026-12-04", eventStart: "20:00" });
    expect(ics).toContain("DTSTART:20261204T190000Z"); // 20:00 WAT
    expect(ics).toContain("DTEND:20261204T220000Z"); // +3h
  });

  it("overnight + all-day", () => {
    const overnight = buildCalendarInvite({ ...base, eventDate: "2026-12-04", eventStart: "22:00", eventEnd: "04:00" });
    expect(overnight).toContain("DTSTART:20261204T210000Z");
    expect(overnight).toContain("DTEND:20261205T030000Z");
    const allDay = buildCalendarInvite({ ...base, eventDate: "2026-12-04", eventEndDate: "2026-12-05" });
    expect(allDay).toContain("DTSTART;VALUE=DATE:20261204");
    expect(allDay).toContain("DTEND;VALUE=DATE:20261206"); // exclusive
  });

  it("returns null without a usable date, escapes text and folds long lines", () => {
    expect(buildCalendarInvite({ ...base, eventDate: "" })).toBeNull();
    expect(buildCalendarInvite({ ...base, eventDate: "garbage" })).toBeNull();
    const ics = buildCalendarInvite({ ...base, title: "Rock, Roll; & \\ Chill", description: "x".repeat(300), eventDate: "2026-12-04" });
    expect(ics).toContain("SUMMARY:Rock\\, Roll\\; & \\\\ Chill");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });

  it("accepts an ISO timestamp date", () => {
    // 2026-12-03T23:30Z is already Dec 4 in Lagos
    const ics = buildCalendarInvite({ ...base, eventDate: "2026-12-03T23:30:00.000Z" });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261204");
  });
});

describe("formatEventWhen", () => {
  it("formats multi-day, single-day and all-day events", () => {
    expect(formatEventWhen({ eventDate: "2026-12-04", eventStart: "13:00", eventEndDate: "2026-12-05", eventEnd: "18:00" }))
      .toBe("Fri, Dec 4, 2026 · 1:00 PM – Sat, Dec 5, 2026 · 6:00 PM");
    expect(formatEventWhen({ eventDate: "2026-12-04", eventStart: "13:00", eventEnd: "18:00" })).toBe("Fri, Dec 4, 2026 · 1:00 PM – 6:00 PM");
    expect(formatEventWhen({ eventDate: "2026-12-04" })).toBe("Fri, Dec 4, 2026");
    expect(formatEventWhen({})).toBe("");
  });
});

describe("buildRawEmail", () => {
  it("builds a multipart/mixed message with html + base64 attachments and safe headers", () => {
    const raw = buildRawEmail({
      from: "Spotix Tickets <tickets@hello.spotix.com.ng>",
      to: "ada@example.com",
      subject: "Your Ticket for Ṣọ́ọ̀lá's Party\r\nBcc: evil@example.com",
      html: "<p>Hi ₦</p>",
      text: "Hi",
      attachments: [
        { filename: "ticket.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-fake") },
        { filename: "invite.ics", contentType: "text/calendar; charset=UTF-8; method=PUBLISH", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" },
      ],
    }).toString("utf8");

    const headerBlock = raw.split("\r\n\r\n")[0];
    expect(headerBlock).not.toMatch(/^Bcc:/m); // header injection neutralised
    expect(headerBlock).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).toContain('Content-Disposition: attachment; filename="ticket.pdf"');
    expect(raw).toContain('Content-Type: text/calendar; charset=UTF-8; method=PUBLISH; name="invite.ics"');
    expect(raw).toContain(Buffer.from("%PDF-fake").toString("base64"));
    const boundary = /multipart\/mixed; boundary="([^"]+)"/.exec(raw)[1];
    expect(raw).toContain(`--${boundary}--`);
  });
});

describe("buildTicketsPdf", () => {
  it("renders one page per ticket", async () => {
    const pdf = await buildTicketsPdf({
      tickets: [
        { ticketId: "SPTX-TX-12345678AB", ticketType: "Regular" },
        { ticketId: "SPTX-TX-87654321CD", ticketType: "VIP" },
        { ticketId: "SPTX-TX-11223344EF", ticketType: "VIP" },
      ],
      eventName: "DevFest Enugu 2026 — a very long event name that has to wrap onto a second line for sure",
      eventHost: "GDG Enugu",
      eventVenue: "Enugu",
      eventWhen: "Fri, Dec 4, 2026 · 1:00 PM – Sat, Dec 5, 2026 · 6:00 PM",
      holderName: "Ada Obi",
      paymentRef: "SPTX-REF-1700000000000-AA",
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const pages = (pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
    expect(pages).toBe(3);
  });

  it("rejects an empty ticket list", async () => {
    await expect(buildTicketsPdf({ tickets: [], eventName: "x" })).rejects.toThrow();
  });
});
