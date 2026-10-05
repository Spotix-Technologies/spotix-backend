// tests/unit/payment.controller.test.js
//
// Unit tests for v1/controllers/payment.controller.js. The only external
// boundary this controller has is undici's `request` — mocked here so
// no real call to Paystack ever happens.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { request as undiciRequest } from "undici";
import {
  initializePayment,
  verifyPayment,
  pingPayment,
  healthCheckPayment,
} from "../../v1/controllers/payment.controller.js";

function fakeReply() {
  const reply = {
    statusCode: null,
    body: null,
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
  return reply;
}

function fakeRequest(overrides = {}) {
  return {
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

function undiciResult(statusCode, data) {
  return { statusCode, body: { json: async () => data } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("initializePayment", () => {
  it("returns Paystack's authorization_url on success", async () => {
    undiciRequest.mockResolvedValueOnce(
      undiciResult(200, { status: true, data: { authorization_url: "https://paystack.test/pay/abc" } })
    );

    const request = fakeRequest({ body: { amount: 5000, email: "buyer@example.test" } });
    const reply = fakeReply();

    await initializePayment(request, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body.data.authorization_url).toBe("https://paystack.test/pay/abc");

    // amount is naira -> kobo
    const [, options] = undiciRequest.mock.calls[0];
    expect(JSON.parse(options.body).amount).toBe(500000);
  });

  it("forwards metadata when provided", async () => {
    undiciRequest.mockResolvedValueOnce(undiciResult(200, { status: true, data: {} }));

    const request = fakeRequest({
      body: { amount: 1000, email: "buyer@example.test", metadata: { eventId: "evt_1" } },
    });
    await initializePayment(request, fakeReply());

    const [, options] = undiciRequest.mock.calls[0];
    expect(JSON.parse(options.body).metadata).toEqual({ eventId: "evt_1" });
  });

  it("propagates Paystack's error status and message", async () => {
    undiciRequest.mockResolvedValueOnce(undiciResult(400, { message: "Invalid email" }));

    const request = fakeRequest({ body: { amount: 5000, email: "buyer@example.test" } });
    const reply = fakeReply();
    await initializePayment(request, reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.body.error).toBe("Invalid email");
  });

  it("returns 408 when the Paystack call times out", async () => {
    undiciRequest.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }));

    const request = fakeRequest({ body: { amount: 5000, email: "buyer@example.test" } });
    const reply = fakeReply();
    await initializePayment(request, reply);

    expect(reply.statusCode).toBe(408);
  });

  it("returns 500 on an unexpected error", async () => {
    undiciRequest.mockRejectedValueOnce(new Error("boom"));

    const request = fakeRequest({ body: { amount: 5000, email: "buyer@example.test" } });
    const reply = fakeReply();
    await initializePayment(request, reply);

    expect(reply.statusCode).toBe(500);
    expect(request.log.error).toHaveBeenCalled();
  });
});

describe("verifyPayment", () => {
  it("returns Paystack's verification payload on success", async () => {
    undiciRequest.mockResolvedValueOnce(undiciResult(200, { status: true, data: { status: "success" } }));

    const request = fakeRequest({ query: { reference: "SPTX-TX-abc123" } });
    const reply = fakeReply();
    await verifyPayment(request, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body.data.status).toBe("success");
    expect(undiciRequest).toHaveBeenCalledWith(
      expect.stringContaining("/transaction/verify/SPTX-TX-abc123"),
      expect.any(Object)
    );
  });

  it("propagates a Paystack error status", async () => {
    undiciRequest.mockResolvedValueOnce(undiciResult(404, { message: "Transaction not found" }));

    const request = fakeRequest({ query: { reference: "bad-ref" } });
    const reply = fakeReply();
    await verifyPayment(request, reply);

    expect(reply.statusCode).toBe(404);
    expect(reply.body.error).toBe("Transaction not found");
  });

  it("returns 408 on timeout", async () => {
    undiciRequest.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" }));

    const request = fakeRequest({ query: { reference: "SPTX-TX-abc" } });
    const reply = fakeReply();
    await verifyPayment(request, reply);

    expect(reply.statusCode).toBe(408);
  });
});

describe("pingPayment / healthCheckPayment", () => {
  it("ping always returns alive", async () => {
    const reply = fakeReply();
    await pingPayment(fakeRequest(), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body.status).toBe("alive");
  });

  it("health check reports healthy when Paystack responds", async () => {
    undiciRequest.mockResolvedValueOnce(undiciResult(200, { status: true, data: [] }));
    const reply = fakeReply();
    await healthCheckPayment(fakeRequest(), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body.status).toBe("healthy");
  });

  it("health check reports unhealthy when Paystack call throws", async () => {
    undiciRequest.mockRejectedValueOnce(new Error("network down"));
    const reply = fakeReply();
    await healthCheckPayment(fakeRequest(), reply);
    expect(reply.statusCode).toBe(503);
    expect(reply.body.status).toBe("unhealthy");
  });
});
