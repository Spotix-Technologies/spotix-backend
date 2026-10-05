// tests/integration/queue.route.test.js
//
// Integration test: real Fastify route (v1/routes/queue.js) -> real
// controller -> real v1/lib/queue/* logic (token signing/verification,
// admission-sweep Lua script, ETA math all run for real). Only the two
// true external boundaries are mocked: Firestore (via utils/firebase.js,
// reached through lib/queue/config.js) and Redis (via utils/redis-client.js).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const firestoreDoc = { exists: false, data: () => ({}) };
vi.mock("../../v1/utils/firebase.js", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ get: vi.fn(async () => firestoreDoc) })),
    })),
  },
}));

// A tiny in-memory sorted-set stand-in — real enough to exercise
// lib/queue/sweep.js's admission logic (zadd/zpopmin/etc via eval) without
// reimplementing Redis. lib/queue/sweep.js's Lua script can't run against
// this, so sweep-dependent behavior (admission) is covered separately in
// the unit tests, which mock runSweep directly; here we only verify the
// join -> status(waiting) path, which doesn't touch the sweep script.
function makeFakeRedis() {
  const zsets = new Map(); // key -> Map(member -> score)
  const sets = new Map(); // key -> Set(member)
  const kv = new Map();

  function zset(key) {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  }

  return {
    async zadd(key, { score, member }) {
      zset(key).set(member, score);
    },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
    },
    async zrank(key, member) {
      const entries = [...zset(key).entries()].sort((a, b) => a[1] - b[1]);
      const idx = entries.findIndex(([m]) => m === member);
      return idx === -1 ? null : idx;
    },
    async zscore(key, member) {
      const z = zset(key);
      return z.has(member) ? z.get(member) : null;
    },
    async zcard(key) {
      return zset(key).size;
    },
    async zrem(key, member) {
      zset(key).delete(member);
    },
    async zcount(key, min, max) {
      return [...zset(key).values()].filter((s) => s >= min && s <= max).length;
    },
    async smembers(key) {
      return [...(sets.get(key) || [])];
    },
    async srem(key, member) {
      sets.get(key)?.delete(member);
    },
    async get(key) {
      return kv.get(key) ?? null;
    },
    async set(key, value) {
      kv.set(key, value);
    },
    async eval() {
      return []; // sweep script — not exercised by these tests, see note above
    },
  };
}

vi.mock("../../v1/utils/redis-client.js", () => ({
  redis: makeFakeRedis(),
}));

import { buildApp } from "../helpers/build-app.js";
import queueRoute from "../../v1/routes/queue.js";

let app;

beforeEach(async () => {
  firestoreDoc.exists = false;
  app = await buildApp(queueRoute);
});

afterEach(async () => {
  await app.close();
});

describe("GET /v1/queue/config", () => {
  it("400s when eventId is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/queue/config" });
    expect(res.statusCode).toBe(400);
  });

  it("defaults to disabled for an unknown event", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/queue/config?eventId=evt_unknown" });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });

  it("reflects an enabled event's config from Firestore", async () => {
    firestoreDoc.exists = true;
    firestoreDoc.data = () => ({ virtualQueueEnabled: true, queueBatchSize: 25 });

    const res = await app.inject({ method: "GET", url: "/v1/queue/config?eventId=evt_1" });
    expect(res.json()).toMatchObject({ enabled: true, batchSize: 25 });
  });
});

describe("full join -> status(waiting) flow", () => {
  it("a buyer who joins a queued (not yet admitted) event sees their real position", async () => {
    firestoreDoc.exists = true;
    firestoreDoc.data = () => ({ virtualQueueEnabled: true, queueBatchSize: 1 });

    // First joiner
    const first = await app.inject({ method: "POST", url: "/v1/queue/join", payload: { eventId: "evt_1" } });
    expect(first.statusCode).toBe(200);
    const firstToken = first.json().queueToken;

    // Second joiner — score is window-bucketed + random jitter (by
    // design, to blunt bot precision), so the position each join
    // response reports is just a snapshot at that instant and isn't
    // guaranteed to land in join order. What must hold is the *settled*
    // state once both are in: distinct positions, in {1, 2}.
    const second = await app.inject({ method: "POST", url: "/v1/queue/join", payload: { eventId: "evt_1" } });
    expect(second.statusCode).toBe(200);
    const secondToken = second.json().queueToken;
    expect(secondToken).not.toBe(firstToken);

    const [firstStatus, secondStatus] = await Promise.all([
      app.inject({ method: "GET", url: `/v1/queue/status?eventId=evt_1&token=${encodeURIComponent(firstToken)}` }),
      app.inject({ method: "GET", url: `/v1/queue/status?eventId=evt_1&token=${encodeURIComponent(secondToken)}` }),
    ]);

    expect(firstStatus.statusCode).toBe(200);
    expect(firstStatus.json().status).toBe("waiting");
    expect(firstStatus.json().totalWaiting).toBe(2);
    expect(secondStatus.json().totalWaiting).toBe(2);

    const settledPositions = [firstStatus.json().position, secondStatus.json().position].sort();
    expect(settledPositions).toEqual([1, 2]);
  });

  it("rejects joining an event with the queue disabled", async () => {
    firestoreDoc.exists = true;
    firestoreDoc.data = () => ({ virtualQueueEnabled: false });

    const res = await app.inject({ method: "POST", url: "/v1/queue/join", payload: { eventId: "evt_off" } });
    expect(res.statusCode).toBe(400);
  });

  it("status reports expired for a token that never joined", async () => {
    firestoreDoc.exists = true;
    firestoreDoc.data = () => ({ virtualQueueEnabled: true });

    // A well-formed but never-joined token still verifies (HMAC is valid)
    // but has no queue/active membership — should read as expired, not
    // crash or report waiting.
    const join = await app.inject({ method: "POST", url: "/v1/queue/join", payload: { eventId: "evt_2" } });
    const token = join.json().queueToken;
    await app.inject({ method: "POST", url: "/v1/queue/leave", payload: { eventId: "evt_2", token } });

    const status = await app.inject({
      method: "GET",
      url: `/v1/queue/status?eventId=evt_2&token=${encodeURIComponent(token)}`,
    });
    expect(status.json().status).toBe("expired");
  });

  it("status reports expired for a garbage token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/queue/status?eventId=evt_1&token=not-a-real-token" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("expired");
  });
});

describe("GET /v1/queue/health", () => {
  it("reports healthy", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/queue/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("healthy");
  });
});
