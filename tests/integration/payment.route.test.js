// tests/integration/payment.route.test.js
//
// Integration test: real Fastify route registration + AJV schema
// validation (v1/routes/payment.js -> v1/controllers/payment.controller.js),
// with only undici (the actual network call to Paystack) mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { request as undiciRequest } from "undici";
import { buildApp } from "../helpers/build-app.js";
import paymentRoute from "../../v1/routes/payment.js";

let app;

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp(paymentRoute);
});

afterEach(async () => {
  await app.close();
});

describe("POST /v1/payment", () => {
  it("400s when amount is missing (schema validation)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/payment",
      payload: { email: "buyer@example.test" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when email is not a valid email (schema validation)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/payment",
      payload: { amount: 1000, email: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when amount exceeds the schema max", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/payment",
      payload: { amount: 999_999_999, email: "buyer@example.test" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("200s and returns Paystack's response for a valid payload", async () => {
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ status: true, data: { authorization_url: "https://paystack.test/x" } }) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/payment",
      payload: { amount: 5000, email: "buyer@example.test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.authorization_url).toBe("https://paystack.test/x");
  });
});

describe("GET /v1/payment/verify", () => {
  it("400s when reference is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/payment/verify" });
    expect(res.statusCode).toBe(400);
  });

  it("400s when reference contains disallowed characters", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/payment/verify?reference=has%20space" });
    expect(res.statusCode).toBe(400);
  });

  it("200s for a well-formed reference", async () => {
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ status: true, data: { status: "success" } }) },
    });

    const res = await app.inject({ method: "GET", url: "/v1/payment/verify?reference=SPTX-TX-abc123" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("success");
  });
});

describe("GET /v1/payment/ping and /v1/payment/health", () => {
  it("ping responds without calling Paystack", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/payment/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("alive");
    expect(undiciRequest).not.toHaveBeenCalled();
  });

  it("health responds healthy when Paystack is reachable", async () => {
    undiciRequest.mockResolvedValueOnce({ statusCode: 200, body: { json: async () => ({ status: true, data: [] }) } });
    const res = await app.inject({ method: "GET", url: "/v1/payment/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("healthy");
  });
});
