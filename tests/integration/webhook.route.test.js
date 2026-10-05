// tests/integration/webhook.route.test.js
//
// v1/routes/webhook.js has no separate controller (all logic lives in
// the route closure), so there's no pure "unit" entry point to call
// directly — these tests drive it through real Fastify HTTP injection,
// with real HMAC signature verification, and mock every business-logic
// module it dispatches to (Firestore, ticket generation, voting/
// election/merch processing, transfer-event processing, Numerox). That
// makes this both the unit AND integration test for this route: it's
// the deepest level webhook.js can be meaningfully isolated at without
// a real Firestore.

import crypto from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const referenceDocState = { exists: true, data: () => ({ eventId: "evt_1", totalAmount: 5000 }) };
const referenceUpdateMock = vi.fn();

vi.mock("../../v1/utils/firebase.js", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn(async () => referenceDocState),
        update: referenceUpdateMock,
      })),
    })),
  },
}));

vi.mock("../../v1/lib/payout/webhook-events.js", () => ({
  processTransferEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../v1/lib/admin-transfer/events.js", () => ({
  processAdminTransferEvents: vi.fn().mockResolvedValue(undefined),
  isAdminTransferReference: vi.fn((ref) => (ref || "").startsWith("SPTX-XFER-")),
}));

vi.mock("../../v1/routes/ticket.js", () => ({
  generateTickets: vi.fn().mockResolvedValue({ alreadyGenerated: false, totalTickets: 1, ticketIds: ["SPTX-TX-1"] }),
}));

vi.mock("../../v1/routes/ticket-agent.js", () => ({
  generateAgentTickets: vi.fn().mockResolvedValue({ alreadyGenerated: false, totalTickets: 1, ticketIds: ["SPTX-TX-2"] }),
}));

vi.mock("../../v1/lib/voting/index.js", () => ({
  processVotingCharge: vi.fn().mockResolvedValue({ processed: true }),
}));

vi.mock("../../v1/lib/election/index.js", () => ({
  processElectionCharge: vi.fn().mockResolvedValue({ processed: true }),
}));

vi.mock("../../v1/lib/merch/index.js", () => ({
  processMerchCharge: vi.fn().mockResolvedValue({ processed: true }),
}));

// Booker credit purchases (email + SMS). Mocked wholesale: the real modules
// pull in Supabase/SES clients at import time.
vi.mock("../../v1/lib/campaigns/billing.js", () => ({
  verifyAndFulfillPurchase: vi.fn().mockResolvedValue({ credits: { available: 500 } }),
}));

vi.mock("../../v1/lib/sms/billing.js", () => ({
  verifyAndFulfillSmsPurchase: vi.fn().mockResolvedValue({ credits: { available: 100 } }),
  markSmsPurchaseFailed: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../v1/lib/numerox.js", () => ({
  numerox: { track: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) },
}));

import { buildApp } from "../helpers/build-app.js";
import webhookRoute from "../../v1/routes/webhook.js";
import { processTransferEvents } from "../../v1/lib/payout/webhook-events.js";
import { processAdminTransferEvents } from "../../v1/lib/admin-transfer/events.js";
import { generateTickets } from "../../v1/routes/ticket.js";
import { generateAgentTickets } from "../../v1/routes/ticket-agent.js";
import { processVotingCharge } from "../../v1/lib/voting/index.js";
import { processElectionCharge } from "../../v1/lib/election/index.js";
import { processMerchCharge } from "../../v1/lib/merch/index.js";
import { verifyAndFulfillPurchase } from "../../v1/lib/campaigns/billing.js";
import { verifyAndFulfillSmsPurchase, markSmsPurchaseFailed } from "../../v1/lib/sms/billing.js";

let app;

function sign(payload) {
  return crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(JSON.stringify(payload)).digest("hex");
}

async function postWebhook(payload, { badSignature = false } = {}) {
  const signature = badSignature ? "not-the-real-signature" : sign(payload);
  return app.inject({
    method: "POST",
    url: "/v1/webhook",
    headers: { "x-paystack-signature": signature },
    payload,
  });
}

function chargeEvent(event, type, overrides = {}) {
  return {
    event,
    data: {
      reference: "SPTX-TX-ref1",
      amount: 500000,
      currency: "NGN",
      customer: { email: "buyer@example.test", customer_code: "CUS_1" },
      gateway_response: "Declined",
      metadata: { custom_fields: [{ variable_name: "type", value: type }] },
      ...overrides,
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  referenceDocState.exists = true;
  referenceDocState.data = () => ({ eventId: "evt_1", totalAmount: 5000 });
  app = await buildApp(webhookRoute);
});

afterEach(async () => {
  await app.close();
});

describe("signature verification", () => {
  it("401s an invalid signature", async () => {
    const res = await postWebhook(chargeEvent("charge.success", "ticket_purchase"), { badSignature: true });
    expect(res.statusCode).toBe(401);
  });

  it("200s a correctly signed, unrecognised event", async () => {
    const res = await postWebhook({ event: "customeridentification.failed", data: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
  });
});

describe("charge.success / charge.failed — ticket_purchase", () => {
  it("marks the reference successful and generates tickets on charge.success", async () => {
    const res = await postWebhook(chargeEvent("charge.success", "ticket_purchase"));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, status: "successful" });
    expect(referenceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "successful", transactionType: "ticket_purchase" })
    );
    expect(generateTickets).toHaveBeenCalled();
    expect(generateAgentTickets).not.toHaveBeenCalled();
  });

  it("uses the agent generator for a pregenerated-pass agent sale", async () => {
    referenceDocState.data = () => ({ eventId: "evt_1", isAgentSale: true, passMode: "pregenerated" });
    const res = await postWebhook(chargeEvent("charge.success", "ticket_purchase"));

    expect(res.statusCode).toBe(200);
    expect(generateAgentTickets).toHaveBeenCalled();
    expect(generateTickets).not.toHaveBeenCalled();
  });

  it("marks the reference failed (with gateway_response) and does NOT generate tickets on charge.failed", async () => {
    const res = await postWebhook(chargeEvent("charge.failed", "ticket_purchase"));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "failed" });
    expect(referenceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", failureReason: "Declined" })
    );
    expect(generateTickets).not.toHaveBeenCalled();
  });

  it("404s when the Reference doc doesn't exist", async () => {
    referenceDocState.exists = false;
    const res = await postWebhook(chargeEvent("charge.success", "ticket_purchase"));
    expect(res.statusCode).toBe(404);
  });

  it("still 200s the webhook even if ticket generation throws (non-blocking)", async () => {
    generateTickets.mockRejectedValueOnce(new Error("Firestore write failed"));
    const res = await postWebhook(chargeEvent("charge.success", "ticket_purchase"));
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it("400s when the reference is missing from the payload", async () => {
    const evt = chargeEvent("charge.success", "ticket_purchase");
    delete evt.data.reference;
    const res = await postWebhook(evt);
    expect(res.statusCode).toBe(400);
  });
});

describe("charge.success — other transaction types dispatch to the right processor", () => {
  it("voting_purchase -> processVotingCharge", async () => {
    const res = await postWebhook(chargeEvent("charge.success", "voting_purchase"));
    expect(res.statusCode).toBe(200);
    expect(processVotingCharge).toHaveBeenCalledWith(expect.anything(), "charge.success", expect.any(Object), "SPTX-TX-ref1");
    expect(processElectionCharge).not.toHaveBeenCalled();
  });

  it("election_form_purchase -> processElectionCharge", async () => {
    const res = await postWebhook(chargeEvent("charge.success", "election_form_purchase"));
    expect(res.statusCode).toBe(200);
    expect(processElectionCharge).toHaveBeenCalled();
    expect(processVotingCharge).not.toHaveBeenCalled();
  });

  it("merch_purchase -> processMerchCharge", async () => {
    const res = await postWebhook(chargeEvent("charge.success", "merch_purchase"));
    expect(res.statusCode).toBe(200);
    expect(processMerchCharge).toHaveBeenCalled();
  });

  it("an unrecognised transaction type is skipped, not errored", async () => {
    const res = await postWebhook(chargeEvent("charge.success", "something_unknown"));
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toMatch(/not handled/i);
    expect(processVotingCharge).not.toHaveBeenCalled();
    expect(generateTickets).not.toHaveBeenCalled();
  });

  it("500s if the voting processor throws", async () => {
    processVotingCharge.mockRejectedValueOnce(new Error("allocation failed"));
    const res = await postWebhook(chargeEvent("charge.success", "voting_purchase"));
    expect(res.statusCode).toBe(500);
  });
});

describe("transfer.* events — dispatch by reference prefix", () => {
  it("SPTX-XFER- references go to processAdminTransferEvents", async () => {
    const res = await postWebhook({ event: "transfer.success", data: { reference: "SPTX-XFER-1" } });
    expect(res.statusCode).toBe(200);
    expect(processAdminTransferEvents).toHaveBeenCalled();
    expect(processTransferEvents).not.toHaveBeenCalled();
  });

  it("SPTX-TRNS- (payout) references go to processTransferEvents", async () => {
    const res = await postWebhook({ event: "transfer.success", data: { reference: "SPTX-TRNS-1" } });
    expect(res.statusCode).toBe(200);
    expect(processTransferEvents).toHaveBeenCalled();
    expect(processAdminTransferEvents).not.toHaveBeenCalled();
  });

  it("transfer.failed and transfer.reversed are both handled", async () => {
    for (const event of ["transfer.failed", "transfer.reversed"]) {
      const res = await postWebhook({ event, data: { reference: "SPTX-TRNS-1" } });
      expect(res.statusCode).toBe(200);
    }
    expect(processTransferEvents).toHaveBeenCalledTimes(2);
  });

  it("still 200s (with success:false) if transfer processing throws — Paystack shouldn't retry-storm us", async () => {
    processTransferEvents.mockRejectedValueOnce(new Error("db write failed"));
    const res = await postWebhook({ event: "transfer.success", data: { reference: "SPTX-TRNS-1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
  });
});

describe("GET /v1/webhook/health", () => {
  it("reports active", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/webhook/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("active");
  });
});

describe("charge.success / charge.failed — booker credit purchases", () => {
  it("fulfils an SMS credit purchase on charge.success", async () => {
    const res = await postWebhook(chargeEvent("charge.success", "sms_credit_purchase", { reference: "SPTX-SMS-1-AB" }));

    expect(res.statusCode).toBe(200);
    expect(verifyAndFulfillSmsPurchase).toHaveBeenCalledWith("SPTX-SMS-1-AB");
    expect(verifyAndFulfillPurchase).not.toHaveBeenCalled();
    expect(generateTickets).not.toHaveBeenCalled();
  });

  it("fulfils an email credit purchase on charge.success", async () => {
    const res = await postWebhook(chargeEvent("charge.success", "email_credit_purchase", { reference: "SPTX-BKR-1-AB" }));

    expect(res.statusCode).toBe(200);
    expect(verifyAndFulfillPurchase).toHaveBeenCalledWith("SPTX-BKR-1-AB");
    expect(verifyAndFulfillSmsPurchase).not.toHaveBeenCalled();
  });

  it("marks a pending SMS purchase failed on charge.failed", async () => {
    const res = await postWebhook(chargeEvent("charge.failed", "sms_credit_purchase", { reference: "SPTX-SMS-2-CD" }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "failed" });
    expect(markSmsPurchaseFailed).toHaveBeenCalledWith("SPTX-SMS-2-CD");
    expect(verifyAndFulfillSmsPurchase).not.toHaveBeenCalled();
  });

  it("marks a pending email purchase failed on charge.failed, but never one already credited", async () => {
    referenceDocState.data = () => ({ creditsIssued: false });
    await postWebhook(chargeEvent("charge.failed", "email_credit_purchase", { reference: "SPTX-BKR-3-EF" }));
    expect(referenceUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));

    referenceUpdateMock.mockClear();
    referenceDocState.data = () => ({ creditsIssued: true });
    await postWebhook(chargeEvent("charge.failed", "email_credit_purchase", { reference: "SPTX-BKR-3-EF" }));
    expect(referenceUpdateMock).not.toHaveBeenCalled();
  });

  it("500s (so Paystack retries) when fulfilment throws", async () => {
    verifyAndFulfillSmsPurchase.mockRejectedValueOnce(new Error("supabase down"));
    const res = await postWebhook(chargeEvent("charge.success", "sms_credit_purchase", { reference: "SPTX-SMS-4-GH" }));
    expect(res.statusCode).toBe(500);
  });
});
