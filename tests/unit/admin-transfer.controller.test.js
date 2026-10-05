// tests/unit/admin-transfer.controller.test.js
//
// Unit tests for v1/controllers/admin-transfer.controller.js. The only
// dependency this controller has is v1/lib/paystack.js — mocked here so
// no real call to Paystack ever happens. calculateTransferFee is real
// (kept via importOriginal) since it's pure, deterministic logic worth
// testing for real.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../v1/lib/paystack.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getWalletBalance: vi.fn(),
    listBanks: vi.fn(),
    resolveAccount: vi.fn(),
    createTransferRecipient: vi.fn(),
    initiateTransfer: vi.fn(),
    listRecentTransfers: vi.fn(),
  };
});

import {
  getWalletBalance,
  listBanks,
  resolveAccount,
  createTransferRecipient,
  initiateTransfer,
  listRecentTransfers,
  PaystackError,
} from "../../v1/lib/paystack.js";
import {
  getWalletBalanceHandler,
  listBanksHandler,
  resolveAccountHandler,
  transferFeeHandler,
  paystackTransfersHandler,
  initiateTransferHandler,
} from "../../v1/controllers/admin-transfer.controller.js";

function fakeReply() {
  return {
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
}

function fakeRequest(overrides = {}) {
  return { log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getWalletBalanceHandler", () => {
  it("returns balances on success", async () => {
    getWalletBalance.mockResolvedValueOnce([{ currency: "NGN", balance: 50000 }]);
    const reply = fakeReply();
    await getWalletBalanceHandler(fakeRequest(), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ success: true, balances: [{ currency: "NGN", balance: 50000 }] });
  });

  it("returns 502 for a Paystack-side failure", async () => {
    getWalletBalance.mockRejectedValueOnce(new PaystackError("Paystack is down", 503));
    const reply = fakeReply();
    await getWalletBalanceHandler(fakeRequest(), reply);
    expect(reply.statusCode).toBe(502);
    expect(reply.body.success).toBe(false);
  });

  it("returns 500 for a non-Paystack error", async () => {
    getWalletBalance.mockRejectedValueOnce(new Error("unexpected"));
    const reply = fakeReply();
    await getWalletBalanceHandler(fakeRequest(), reply);
    expect(reply.statusCode).toBe(500);
  });
});

describe("listBanksHandler", () => {
  it("returns the bank list", async () => {
    listBanks.mockResolvedValueOnce([{ name: "GTBank", code: "058" }]);
    const reply = fakeReply();
    await listBanksHandler(fakeRequest(), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body.banks).toHaveLength(1);
  });
});

describe("resolveAccountHandler", () => {
  it("400s when accountNumber or bankCode is missing", async () => {
    const reply = fakeReply();
    await resolveAccountHandler(fakeRequest({ body: { accountNumber: "0123456789" } }), reply);
    expect(reply.statusCode).toBe(400);
    expect(resolveAccount).not.toHaveBeenCalled();
  });

  it("returns the resolved account name on success", async () => {
    resolveAccount.mockResolvedValueOnce({ accountName: "Jane Doe" });
    const reply = fakeReply();
    await resolveAccountHandler(fakeRequest({ body: { accountNumber: "0123456789", bankCode: "058" } }), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body.accountName).toBe("Jane Doe");
  });

  it("returns 400 when Paystack can't resolve the account", async () => {
    resolveAccount.mockRejectedValueOnce(new PaystackError("Could not resolve account name", 400));
    const reply = fakeReply();
    await resolveAccountHandler(fakeRequest({ body: { accountNumber: "0000000000", bankCode: "058" } }), reply);
    expect(reply.statusCode).toBe(400);
  });
});

describe("transferFeeHandler", () => {
  it("400s for a non-positive amount", async () => {
    const reply = fakeReply();
    await transferFeeHandler(fakeRequest({ query: { amount: "-5" } }), reply);
    expect(reply.statusCode).toBe(400);
  });

  it("computes the real fee schedule for a small amount", async () => {
    const reply = fakeReply();
    await transferFeeHandler(fakeRequest({ query: { amount: "3000" } }), reply);
    expect(reply.body).toEqual({ success: true, amount: 3000, fee: 10, amountAfterFee: 2990 });
  });

  it("computes the real fee schedule for a mid-range amount", async () => {
    const reply = fakeReply();
    await transferFeeHandler(fakeRequest({ query: { amount: "20000" } }), reply);
    expect(reply.body.fee).toBe(25);
  });

  it("computes the real fee schedule for a large amount", async () => {
    const reply = fakeReply();
    await transferFeeHandler(fakeRequest({ query: { amount: "200000" } }), reply);
    expect(reply.body.fee).toBe(50);
  });
});

describe("paystackTransfersHandler", () => {
  it("filters out our own-reference transfers (SPTX-XFER-/SPTX-TRNS-)", async () => {
    listRecentTransfers.mockResolvedValueOnce({
      transfers: [
        { reference: "SPTX-XFER-123", amount: 1000 },
        { reference: "SPTX-TRNS-456", amount: 2000 },
        { reference: "manual-dashboard-withdrawal-789", amount: 3000 },
      ],
      meta: { total: 3 },
    });

    const reply = fakeReply();
    await paystackTransfersHandler(fakeRequest({ query: {} }), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body.transfers).toHaveLength(1);
    expect(reply.body.transfers[0].reference).toBe("manual-dashboard-withdrawal-789");
  });

  it("clamps perPage to the 1-50 range", async () => {
    listRecentTransfers.mockResolvedValueOnce({ transfers: [], meta: null });
    const reply = fakeReply();
    await paystackTransfersHandler(fakeRequest({ query: { perPage: "500" } }), reply);
    expect(listRecentTransfers).toHaveBeenCalledWith({ page: 1, perPage: 50 });
  });
});

describe("initiateTransferHandler", () => {
  it("400s when required fields are missing", async () => {
    const reply = fakeReply();
    await initiateTransferHandler(fakeRequest({ body: { reference: "SPTX-XFER-1" } }), reply);
    expect(reply.statusCode).toBe(400);
  });

  it("400s when creating a new recipient without bank details", async () => {
    const reply = fakeReply();
    await initiateTransferHandler(
      fakeRequest({ body: { reference: "SPTX-XFER-1", amount: 1000, reason: "Payout" } }),
      reply
    );
    expect(reply.statusCode).toBe(400);
    expect(createTransferRecipient).not.toHaveBeenCalled();
  });

  it("creates a recipient then initiates the transfer when no recipientCode is given", async () => {
    createTransferRecipient.mockResolvedValueOnce({ recipientCode: "RCP_new" });
    initiateTransfer.mockResolvedValueOnce({ transferCode: "TRF_1", status: "pending" });

    const reply = fakeReply();
    await initiateTransferHandler(
      fakeRequest({
        body: {
          reference: "SPTX-XFER-1",
          amount: 5000,
          reason: "Payout",
          bankCode: "058",
          accountNumber: "0123456789",
          accountName: "Jane Doe",
        },
      }),
      reply
    );

    expect(createTransferRecipient).toHaveBeenCalledWith({
      name: "Jane Doe",
      accountNumber: "0123456789",
      bankCode: "058",
      email: undefined,
    });
    expect(initiateTransfer).toHaveBeenCalledWith({
      amount: 5000,
      recipientCode: "RCP_new",
      reason: "Payout",
      reference: "SPTX-XFER-1",
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.body.transferCode).toBe("TRF_1");
  });

  it("skips recipient creation when recipientCode is already provided", async () => {
    initiateTransfer.mockResolvedValueOnce({ transferCode: "TRF_2", status: "pending" });

    const reply = fakeReply();
    await initiateTransferHandler(
      fakeRequest({
        body: { reference: "SPTX-XFER-2", amount: 1000, reason: "Payout", recipientCode: "RCP_existing" },
      }),
      reply
    );

    expect(createTransferRecipient).not.toHaveBeenCalled();
    expect(initiateTransfer).toHaveBeenCalledWith({
      amount: 1000,
      recipientCode: "RCP_existing",
      reason: "Payout",
      reference: "SPTX-XFER-2",
    });
    expect(reply.statusCode).toBe(200);
  });

  it("returns 502 when Paystack rejects the transfer", async () => {
    initiateTransfer.mockRejectedValueOnce(new PaystackError("Insufficient balance", 400));

    const reply = fakeReply();
    await initiateTransferHandler(
      fakeRequest({
        body: { reference: "SPTX-XFER-3", amount: 1000, reason: "Payout", recipientCode: "RCP_existing" },
      }),
      reply
    );

    expect(reply.statusCode).toBe(502);
    expect(reply.body.success).toBe(false);
  });
});
