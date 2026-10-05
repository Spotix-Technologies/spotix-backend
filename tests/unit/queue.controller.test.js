// tests/unit/queue.controller.test.js
//
// Unit tests for v1/controllers/queue.controller.js. Redis and every
// v1/lib/queue/* helper are mocked so this only exercises the
// controller's own request handling and branching.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../v1/utils/redis-client.js", () => ({
  redis: {
    zadd: vi.fn(),
    sadd: vi.fn(),
    zrank: vi.fn(),
    zscore: vi.fn(),
    zcard: vi.fn(),
    zrem: vi.fn(),
  },
}));

vi.mock("../../v1/lib/queue/token.js", () => ({
  signToken: vi.fn(() => "signed-token-abc"),
  verifyToken: vi.fn(),
}));

vi.mock("../../v1/lib/queue/config.js", () => ({
  getQueueConfig: vi.fn(),
}));

vi.mock("../../v1/lib/queue/sweep.js", () => ({
  runSweep: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../v1/lib/queue/eta.js", () => ({
  estimateWait: vi.fn().mockResolvedValue({ etaSeconds: 30, etaLabel: "Less than a minute" }),
}));

import { redis } from "../../v1/utils/redis-client.js";
import { signToken, verifyToken } from "../../v1/lib/queue/token.js";
import { getQueueConfig } from "../../v1/lib/queue/config.js";
import { runSweep } from "../../v1/lib/queue/sweep.js";
import { estimateWait } from "../../v1/lib/queue/eta.js";
import {
  getQueueConfigHandler,
  joinQueue,
  getQueueStatus,
  completeQueue,
  leaveQueue,
  queueHealth,
} from "../../v1/controllers/queue.controller.js";

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
  return {
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    server: { fake: "fastify-instance" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getQueueConfigHandler", () => {
  it("400s when eventId is missing", async () => {
    const reply = fakeReply();
    await getQueueConfigHandler(fakeRequest({ query: {} }), reply);
    expect(reply.statusCode).toBe(400);
  });

  it("returns enabled + batchSize for a known event", async () => {
    getQueueConfig.mockResolvedValueOnce({ enabled: true, batchSize: 50, sessionTTL: 480 });
    const reply = fakeReply();
    await getQueueConfigHandler(fakeRequest({ query: { eventId: "evt_1" } }), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toMatchObject({ success: true, enabled: true, batchSize: 50 });
  });
});

describe("joinQueue", () => {
  it("400s when eventId is missing", async () => {
    const reply = fakeReply();
    await joinQueue(fakeRequest({ body: {} }), reply);
    expect(reply.statusCode).toBe(400);
  });

  it("400s when the queue is not enabled for this event", async () => {
    getQueueConfig.mockResolvedValueOnce({ enabled: false, batchSize: 50, sessionTTL: 480 });
    const reply = fakeReply();
    await joinQueue(fakeRequest({ body: { eventId: "evt_1" } }), reply);
    expect(reply.statusCode).toBe(400);
    expect(redis.zadd).not.toHaveBeenCalled();
  });

  it("issues a signed token and reports 1-indexed position on success", async () => {
    getQueueConfig.mockResolvedValueOnce({ enabled: true, batchSize: 50, sessionTTL: 480 });
    redis.zrank.mockResolvedValueOnce(0); // first in line

    const reply = fakeReply();
    await joinQueue(fakeRequest({ body: { eventId: "evt_1" } }), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body.queueToken).toBe("signed-token-abc");
    expect(reply.body.position).toBe(1);
    expect(redis.zadd).toHaveBeenCalledWith(expect.stringContaining("evt_1"), expect.objectContaining({ member: "signed-token-abc" }));
    expect(redis.sadd).toHaveBeenCalled();
  });

  it("500s and logs if Redis throws", async () => {
    getQueueConfig.mockResolvedValueOnce({ enabled: true, batchSize: 50, sessionTTL: 480 });
    redis.zadd.mockRejectedValueOnce(new Error("redis down"));

    const request = fakeRequest({ body: { eventId: "evt_1" } });
    const reply = fakeReply();
    await joinQueue(request, reply);

    expect(reply.statusCode).toBe(500);
    expect(request.log.error).toHaveBeenCalled();
  });
});

describe("getQueueStatus", () => {
  it("400s when eventId or token is missing", async () => {
    const reply = fakeReply();
    await getQueueStatus(fakeRequest({ query: { eventId: "evt_1" } }), reply);
    expect(reply.statusCode).toBe(400);
  });

  it("reports expired when the token doesn't verify", async () => {
    verifyToken.mockReturnValueOnce(null);
    const reply = fakeReply();
    await getQueueStatus(fakeRequest({ query: { eventId: "evt_1", token: "bad" } }), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body.status).toBe("expired");
  });

  it("reports expired when the token's eventId doesn't match the query", async () => {
    verifyToken.mockReturnValueOnce({ eventId: "evt_OTHER" });
    const reply = fakeReply();
    await getQueueStatus(fakeRequest({ query: { eventId: "evt_1", token: "tok" } }), reply);
    expect(reply.body.status).toBe("expired");
  });

  it("reports admitted when the token has an active (unexpired) slot", async () => {
    verifyToken.mockReturnValueOnce({ eventId: "evt_1" });
    getQueueConfig.mockResolvedValueOnce({ enabled: true, batchSize: 50, sessionTTL: 480 });
    const future = Math.floor(Date.now() / 1000) + 300;
    redis.zscore.mockResolvedValueOnce(future);

    const reply = fakeReply();
    await getQueueStatus(fakeRequest({ query: { eventId: "evt_1", token: "tok" } }), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body.status).toBe("admitted");
    expect(reply.body.expiresAt).toBe(future);
  });

  it("reports expired when not admitted and no longer ranked in the queue", async () => {
    verifyToken.mockReturnValueOnce({ eventId: "evt_1" });
    getQueueConfig.mockResolvedValueOnce({ enabled: true, batchSize: 50, sessionTTL: 480 });
    redis.zscore.mockResolvedValueOnce(null);
    redis.zrank.mockResolvedValueOnce(null);

    const reply = fakeReply();
    await getQueueStatus(fakeRequest({ query: { eventId: "evt_1", token: "tok" } }), reply);

    expect(reply.body.status).toBe("expired");
  });

  it("reports waiting with a 1-indexed position and ETA when still queued", async () => {
    verifyToken.mockReturnValueOnce({ eventId: "evt_1" });
    getQueueConfig.mockResolvedValueOnce({ enabled: true, batchSize: 50, sessionTTL: 480 });
    redis.zscore.mockResolvedValueOnce(null);
    redis.zrank.mockResolvedValueOnce(4);
    redis.zcard.mockResolvedValueOnce(10);

    const reply = fakeReply();
    await getQueueStatus(fakeRequest({ query: { eventId: "evt_1", token: "tok" } }), reply);

    expect(reply.body.status).toBe("waiting");
    expect(reply.body.position).toBe(5);
    expect(reply.body.totalWaiting).toBe(10);
    expect(reply.body.etaSeconds).toBe(30);
    expect(estimateWait).toHaveBeenCalledWith("evt_1", 4, 50);
  });
});

describe("completeQueue", () => {
  it("always 200s, even with a missing eventId/token", async () => {
    const reply = fakeReply();
    await completeQueue(fakeRequest({ body: {} }), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body.success).toBe(false);
  });

  it("removes the token from the active set and triggers an immediate sweep", async () => {
    getQueueConfig.mockResolvedValueOnce({ enabled: true, batchSize: 50, sessionTTL: 480 });
    const reply = fakeReply();
    const request = fakeRequest({ body: { eventId: "evt_1", token: "tok" } });
    await completeQueue(request, reply);

    expect(redis.zrem).toHaveBeenCalledWith(expect.stringContaining("active"), "tok");
    expect(reply.statusCode).toBe(200);
    expect(reply.body.success).toBe(true);
    // fire-and-forget: called with the fastify instance via request.server
    await new Promise((r) => setImmediate(r));
    expect(runSweep).toHaveBeenCalledWith(request.server, "evt_1", 50, 480);
  });

  it("200s even if Redis throws (non-blocking by design)", async () => {
    getQueueConfig.mockRejectedValueOnce(new Error("redis down"));
    const reply = fakeReply();
    await completeQueue(fakeRequest({ body: { eventId: "evt_1", token: "tok" } }), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body.success).toBe(false);
  });
});

describe("leaveQueue", () => {
  it("removes the token from the waiting queue", async () => {
    const reply = fakeReply();
    await leaveQueue(fakeRequest({ body: { eventId: "evt_1", token: "tok" } }), reply);
    expect(redis.zrem).toHaveBeenCalledWith(expect.stringContaining("evt_1"), "tok");
    expect(reply.statusCode).toBe(200);
    expect(reply.body.success).toBe(true);
  });

  it("200s even if Redis throws (non-blocking by design)", async () => {
    redis.zrem.mockRejectedValueOnce(new Error("redis down"));
    const reply = fakeReply();
    await leaveQueue(fakeRequest({ body: { eventId: "evt_1", token: "tok" } }), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body.success).toBe(false);
  });
});

describe("queueHealth", () => {
  it("reports healthy", async () => {
    const reply = fakeReply();
    await queueHealth(fakeRequest(), reply);
    expect(reply.statusCode).toBe(200);
    expect(reply.body.status).toBe("healthy");
  });
});
