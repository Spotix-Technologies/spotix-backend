// tests/integration/admin-transfer.route.test.js
//
// Integration test: real Fastify route (v1/routes/admin-transfer.js) ->
// real requireInternalSecret middleware -> real controller -> real
// v1/lib/paystack.js. Only `fetch` (the actual call to Paystack's API)
// is mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildApp } from "../helpers/build-app.js";
import adminTransferRoute from "../../v1/routes/admin-transfer.js";

const INTERNAL_SECRET = process.env.CRON_SECRET;

let app;
let fetchMock;

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  app = await buildApp(adminTransferRoute);
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

function paystackOk(data) {
  return { ok: true, json: async () => ({ status: true, data }) };
}
function paystackFail(status, message) {
  return { ok: false, status, json: async () => ({ status: false, message }) };
}

describe("internal-secret guard", () => {
  it("401s every route with no x-internal-secret header", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/wallet-balance" });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401s with the wrong secret", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/wallet-balance",
      headers: { "x-internal-secret": "wrong-secret" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/admin/wallet-balance", () => {
  it("200s with balances for the right secret", async () => {
    fetchMock.mockResolvedValueOnce(paystackOk([{ currency: "NGN", balance: 500000 }]));

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/wallet-balance",
      headers: { "x-internal-secret": INTERNAL_SECRET },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().balances).toEqual([{ currency: "NGN", balance: 5000 }]);
  });

  it("502s when Paystack itself fails", async () => {
    fetchMock.mockResolvedValueOnce(paystackFail(503, "Service unavailable"));

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/wallet-balance",
      headers: { "x-internal-secret": INTERNAL_SECRET },
    });

    expect(res.statusCode).toBe(502);
  });
});

describe("POST /v1/admin/resolve-account", () => {
  it("400s without the internal secret guard even reaching validation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/resolve-account",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("resolves an account name for a valid request", async () => {
    fetchMock.mockResolvedValueOnce(paystackOk({ account_name: "Jane Doe" }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/resolve-account",
      headers: { "x-internal-secret": INTERNAL_SECRET },
      payload: { accountNumber: "0123456789", bankCode: "058" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().accountName).toBe("Jane Doe");
  });
});

describe("GET /v1/admin/transfer-fee", () => {
  it("computes the real fee (no Paystack call needed)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/transfer-fee?amount=3000",
      headers: { "x-internal-secret": INTERNAL_SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ amount: 3000, fee: 10, amountAfterFee: 2990 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /v1/admin/initiate-transfer", () => {
  it("creates a recipient and initiates a transfer end to end", async () => {
    fetchMock
      .mockResolvedValueOnce(paystackOk({ recipient_code: "RCP_123" })) // createTransferRecipient
      .mockResolvedValueOnce(paystackOk({ transfer_code: "TRF_123", status: "pending" })); // initiateTransfer

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/initiate-transfer",
      headers: { "x-internal-secret": INTERNAL_SECRET },
      payload: {
        reference: "SPTX-XFER-abc",
        amount: 10000,
        reason: "Team disbursement",
        bankCode: "058",
        accountNumber: "0123456789",
        accountName: "Jane Doe",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, recipientCode: "RCP_123", transferCode: "TRF_123" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // amount was converted naira -> kobo on the way to Paystack
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondCallBody.amount).toBe(1000000);
  });

  it("400s when required fields are missing, before ever calling Paystack", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/initiate-transfer",
      headers: { "x-internal-secret": INTERNAL_SECRET },
      payload: { reference: "SPTX-XFER-abc" },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
