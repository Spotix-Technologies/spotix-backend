// tests/unit/edit-history-diff.test.js
// Pure-logic tests for v1/lib/edit-history/diff.js (no I/O, no mocks needed).

import { describe, it, expect } from "vitest";
import { diffObjects, sanitizeChanges, sanitizeValue, buildSummary } from "../../v1/lib/edit-history/diff.js";

describe("diffObjects", () => {
  it("keeps only fields that actually changed", () => {
    const out = diffObjects({ eventName: "A", eventVenue: "X" }, { eventName: "B", eventVenue: "X" });
    expect(out).toEqual({ eventName: { before: "A", after: "B" } });
  });

  it("returns {} for a no-op save", () => {
    expect(diffObjects({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual({});
  });

  it("detects nested array changes (ticket tiers)", () => {
    const out = diffObjects({ ticketPrices: [{ policy: "R", price: 100 }] }, { ticketPrices: [{ policy: "R", price: 200 }] });
    expect(Object.keys(out)).toEqual(["ticketPrices"]);
  });

  it("never records system-maintained or secret fields", () => {
    const out = diffObjects(
      { updatedAt: 1, usedCount: 1, vaultKey: "a", apiToken: "a" },
      { updatedAt: 2, usedCount: 2, vaultKey: "b", apiToken: "b" },
    );
    expect(out).toEqual({});
  });

  it("treats undefined and null as the same 'not set'", () => {
    expect(diffObjects({ a: undefined }, { a: null })).toEqual({});
  });
});

describe("sanitize", () => {
  it("drops secret-looking keys from nested objects", () => {
    expect(sanitizeValue({ code: "X", secretKey: "no" })).toEqual({ code: "X" });
  });

  it("truncates very long strings", () => {
    expect(sanitizeValue("a".repeat(5000)).length).toBeLessThan(2100);
  });

  it("sanitizeChanges strips ignored fields", () => {
    expect(sanitizeChanges({ updatedAt: { before: 1, after: 2 }, eventName: { before: "A", after: "B" } })).toEqual({
      eventName: { before: "A", after: "B" },
    });
  });
});

describe("buildSummary", () => {
  it("lists friendly field names and collapses long lists", () => {
    const changes = Object.fromEntries(["eventName", "eventVenue", "ticketPrices", "eventDate", "eventType", "country"].map((k) => [k, { before: 1, after: 2 }]));
    expect(buildSummary("event_updated", changes)).toBe("Changed name, venue, ticket prices, start date +2 more");
  });
});

describe("equality normalisation", () => {
  it("ignores number-vs-numeric-string and ''-vs-null differences", () => {
    const out = diffObjects(
      { ticketPrices: [{ policy: "R", price: 5000, ticketsSold: 3 }], note: "" },
      { ticketPrices: [{ policy: "R", price: "5000", ticketsSold: 9 }], note: null },
    );
    expect(out).toEqual({});
  });
});
