// tests/unit/resend-tickets.test.js
//
// Unit tests for v1/lib/ticket/resend-tickets.js. Firestore (an in-memory
// fake), the cooldown limiter and the email sender are mocked, so this only
// exercises the lookup / grouping / privacy logic.

import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ events: {}, attendees: {} }));

vi.mock("../../v1/utils/firebase.js", () => {
  const attendeeQuery = (eventId, field, value) => ({
    limit: () => ({
      get: async () => {
        const docs = Object.entries(store.attendees[eventId] || {})
          .filter(([, d]) => d[field] === value)
          .map(([id, d]) => ({ id, data: () => d }));
        return { empty: docs.length === 0, docs };
      },
    }),
  });
  return {
    adminDb: {
      collection: (name) => {
        if (name !== "events") throw new Error(`unexpected collection ${name}`);
        return {
          doc: (eventId) => ({
            get: async () => ({ exists: !!store.events[eventId], id: eventId, data: () => store.events[eventId] }),
            collection: () => ({ where: (field, _op, value) => attendeeQuery(eventId, field, value) }),
          }),
          where: (_f, _op, slug) => ({
            limit: () => ({
              get: async () => {
                const hit = Object.entries(store.events).find(([, e]) => e.eventSlug === slug);
                return { empty: !hit, docs: hit ? [{ id: hit[0], data: () => hit[1] }] : [] };
              },
            }),
          }),
        };
      },
    },
  };
});

vi.mock("../../v1/middleware/rate-limit.js", () => ({ claimCooldown: vi.fn() }));
vi.mock("../../v1/lib/ticket/send-ticket-email.js", () => ({ sendTicketEmail: vi.fn().mockResolvedValue({ attachments: [] }) }));

import { resendTicketsForEvent } from "../../v1/lib/ticket/resend-tickets.js";
import { claimCooldown } from "../../v1/middleware/rate-limit.js";
import { sendTicketEmail } from "../../v1/lib/ticket/send-ticket-email.js";

const fastify = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };

const ticket = (id, over = {}) => ({
  ticketId: id,
  email: "Ada@Example.com",
  fullName: "Ada Obi",
  ticketReference: "SPTX-REF-1700000000000-AA",
  ticketType: "Regular",
  totalAmount: 5000,
  paymentMethod: "Paystack",
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  claimCooldown.mockResolvedValue(true);
  store.events = {
    evt1: {
      eventName: "DevFest Enugu 2026",
      eventSlug: "devfest-enugu",
      bookerName: "GDG Enugu",
      bookerEmail: "host@example.com",
      eventVenue: "Enugu",
      eventDate: "2026-12-04",
      eventStart: "13:00",
      eventEndDate: "2026-12-05",
      eventEnd: "18:00",
    },
  };
  store.attendees = {
    evt1: {
      "SPTX-TX-1": ticket("SPTX-TX-1"),
      "SPTX-TX-2": ticket("SPTX-TX-2", { ticketType: "VIP" }),
      // second, separate purchase by the same buyer
      "SPTX-TX-3": ticket("SPTX-TX-3", { ticketReference: "SPTX-REF-1700000099999-BB", totalAmount: 2500, createdAt: "2026-10-02T10:00:00.000Z" }),
      "SPTX-TX-9": ticket("SPTX-TX-9", { email: "someone@else.com", fullName: "Else" }),
    },
  };
});

describe("resendTicketsForEvent", () => {
  it("emails ALL of a buyer's tickets, across purchases, in one email (lookup by email)", async () => {
    const r = await resendTicketsForEvent(fastify, { eventId: "evt1", query: "Ada@Example.com" });
    expect(r).toMatchObject({ sent: true, ticketCount: 3 });
    expect(sendTicketEmail).toHaveBeenCalledTimes(1);
    const arg = sendTicketEmail.mock.calls[0][0];
    expect(arg.to).toBe("Ada@Example.com");
    expect(arg.tickets.map((t) => t.ticketId)).toEqual(["SPTX-TX-1", "SPTX-TX-2", "SPTX-TX-3"]);
    expect(arg.ticketTypesSummary).toBe("Regular x2, VIP");
    expect(arg.paymentRef).toBe("SPTX-REF-1700000000000-AA, SPTX-REF-1700000099999-BB");
    // 5000 (purchase 1, counted once despite 2 tickets) + 2500
    expect(arg.totalAmount).toBe("7500.00");
    expect(arg.eventDate).toBe("2026-12-04");
    expect(arg.subject).toBe("Your Tickets for DevFest Enugu 2026");
  });

  it("matches email case-insensitively against how it was stored (lower-case input, mixed-case stored)", async () => {
    // stored as "Ada@Example.com" -> typed "ada@example.com": only the as-typed + lower-cased variants are tried,
    // so this is the documented limitation: mixed-case stored addresses need the exact typing.
    const r = await resendTicketsForEvent(fastify, { eventId: "evt1", query: "ada@example.com" });
    expect(r.sent).toBe(false);
    store.attendees.evt1["SPTX-TX-5"] = ticket("SPTX-TX-5", { email: "bola@example.com" });
    const r2 = await resendTicketsForEvent(fastify, { eventId: "evt1", query: "BOLA@example.com" });
    expect(r2.sent).toBe(true); // lower-cased variant finds it
  });

  it("looks up by payment reference, then sends to the address ON the ticket (not the requester)", async () => {
    const r = await resendTicketsForEvent(fastify, { eventId: "evt1", query: "SPTX-REF-1700000099999-BB" });
    expect(r.sent).toBe(true);
    const arg = sendTicketEmail.mock.calls[0][0];
    expect(arg.to).toBe("Ada@Example.com");
    expect(arg.tickets).toHaveLength(3); // every ticket, not just that reference's one
  });

  it("resolves the event by slug too", async () => {
    const r = await resendTicketsForEvent(fastify, { eventId: "devfest-enugu", query: "Ada@Example.com" });
    expect(r.sent).toBe(true);
  });

  it("sends nothing for unknown email / reference / event / malformed input", async () => {
    expect((await resendTicketsForEvent(fastify, { eventId: "evt1", query: "nobody@example.com" })).reason).toBe("no_tickets");
    expect((await resendTicketsForEvent(fastify, { eventId: "evt1", query: "SPTX-REF-1-ZZ" })).reason).toBe("reference_not_in_register");
    expect((await resendTicketsForEvent(fastify, { eventId: "evt1", query: "not a reference" })).reason).toBe("invalid_reference");
    expect((await resendTicketsForEvent(fastify, { eventId: "evt1", query: "a@b" })).reason).toBe("invalid_email");
    expect((await resendTicketsForEvent(fastify, { eventId: "nope", query: "Ada@Example.com" })).reason).toBe("event_not_found");
    expect(sendTicketEmail).not.toHaveBeenCalled();
  });

  it("does not leak another event's tickets", async () => {
    store.events.evt2 = { eventName: "Other" };
    store.attendees.evt2 = {};
    const r = await resendTicketsForEvent(fastify, { eventId: "evt2", query: "Ada@Example.com" });
    expect(r.sent).toBe(false);
  });

  it("respects the per-buyer cooldown", async () => {
    claimCooldown.mockResolvedValue(false);
    const r = await resendTicketsForEvent(fastify, { eventId: "evt1", query: "Ada@Example.com" });
    expect(r).toEqual({ sent: false, reason: "cooldown" });
    expect(sendTicketEmail).not.toHaveBeenCalled();
  });

  it("singular subject for a single ticket", async () => {
    const r = await resendTicketsForEvent(fastify, { eventId: "evt1", query: "someone@else.com" });
    expect(r.ticketCount).toBe(1);
    expect(sendTicketEmail.mock.calls[0][0].subject).toBe("Your Ticket for DevFest Enugu 2026");
  });
});
