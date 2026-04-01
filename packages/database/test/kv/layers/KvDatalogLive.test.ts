/**
 * Tests for KvDatalogLive through the DatalogService Effect interface.
 *
 * These tests verify the KV-backed Datalog engine works correctly when
 * accessed through the standard DatalogService API.
 */

import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { TripleStore } from "../../../src/store/TripleStore.js";
import { Datalog } from "../../../src/datalog/service.js";
import { KvTripleStoreLive } from "../../../src/kv/layers/KvTripleStoreLive.js";
import { KvDatalogLive } from "../../../src/kv/layers/KvDatalogLive.js";
import { KvBackend } from "../../../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../../../src/kv/kv/InMemoryKvBackend.js";

// ─── Test setup ────────────────────────────────────────────────────────────

const str = (value: string) => ({ type: "string" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const refVal = (value: string) => ({ type: "ref" as const, value });

// Layer: KvDatalogLive + KvTripleStoreLive ← fresh InMemoryKvBackend per test
const makeTestLayer = () => {
  const freshKvBackend = Layer.effect(
    KvBackend,
    Effect.sync(() => makeTestKvBackend()),
  );
  return KvDatalogLive.pipe(Layer.provideMerge(KvTripleStoreLive), Layer.provide(freshKvBackend));
};

const runTest = <A, E>(effect: Effect.Effect<A, E, TripleStore | Datalog>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, makeTestLayer()));

// Shared seed data
const seedPeople = Effect.gen(function* () {
  const store = yield* TripleStore;
  yield* store.assertBatch([
    { entityId: "p:alice", attribute: ":person/name", value: str("Alice") },
    { entityId: "p:alice", attribute: ":person/age", value: num(30) },
    { entityId: "p:bob", attribute: ":person/name", value: str("Bob") },
    { entityId: "p:bob", attribute: ":person/age", value: num(25) },
    { entityId: "p:charlie", attribute: ":person/name", value: str("Charlie") },
    { entityId: "p:charlie", attribute: ":person/age", value: num(35) },
    { entityId: "p:alice", attribute: ":person/dept", value: refVal("d:eng") },
    { entityId: "p:bob", attribute: ":person/dept", value: refVal("d:eng") },
    { entityId: "p:charlie", attribute: ":person/dept", value: refVal("d:sales") },
    { entityId: "d:eng", attribute: ":dept/name", value: str("Engineering") },
    { entityId: "d:sales", attribute: ":dept/name", value: str("Sales") },
  ]);
});

// ─── Basic queries ─────────────────────────────────────────────────────────

describe("KvDatalogLive - query", () => {
  it("executes a simple pattern query", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Datalog;

        const { results } = yield* datalog.query({
          find: ["?name"],
          where: [["?person", ":person/name", "?name"]],
        });

        expect(results.length).toBe(3);
        const names = results.map((r) => r["?name"]).sort();
        expect(names).toEqual(["Alice", "Bob", "Charlie"]);
      }),
    );
  });

  it("executes a join query", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Datalog;

        const { results } = yield* datalog.query({
          find: ["?name", "?age"],
          where: [
            ["?person", ":person/name", "?name"],
            ["?person", ":person/age", "?age"],
          ],
        });

        expect(results.length).toBe(3);
        const alice = results.find((r) => r["?name"] === "Alice");
        expect(alice!["?age"]).toBe(30);
      }),
    );
  });

  it("executes a query with predicates", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Datalog;

        const { results } = yield* datalog.query({
          find: ["?name"],
          where: [
            ["?person", ":person/name", "?name"],
            ["?person", ":person/age", "?age"],
            [">=", "?age", 30],
          ],
        });

        expect(results.length).toBe(2);
        const names = results.map((r) => r["?name"]).sort();
        expect(names).toEqual(["Alice", "Charlie"]);
      }),
    );
  });

  it("executes a multi-hop join through refs", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Datalog;

        const { results } = yield* datalog.query({
          find: ["?name", "?deptName"],
          where: [
            ["?person", ":person/name", "?name"],
            ["?person", ":person/dept", "?dept"],
            ["?dept", ":dept/name", "?deptName"],
          ],
          orderBy: [{ variable: "?name" }],
        });

        expect(results.length).toBe(3);
        expect(results[0]!["?name"]).toBe("Alice");
        expect(results[0]!["?deptName"]).toBe("Engineering");
        expect(results[2]!["?name"]).toBe("Charlie");
        expect(results[2]!["?deptName"]).toBe("Sales");
      }),
    );
  });
});

// ─── Query validation ──────────────────────────────────────────────────────

describe("KvDatalogLive - query validation", () => {
  it("rejects invalid queries", async () => {
    await runTest(
      Effect.gen(function* () {
        const datalog = yield* Datalog;

        const result = yield* Effect.either(datalog.query({ not: "a valid query" }));

        expect(result._tag).toBe("Left");
      }),
    );
  });
});

// ─── queryValidated ────────────────────────────────────────────────────────

describe("KvDatalogLive - queryValidated", () => {
  it("executes pre-validated queries", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Datalog;

        const { results } = yield* datalog.queryValidated({
          find: ["?name"],
          where: [["?person", ":person/name", "?name"]],
        });

        expect(results.length).toBe(3);
      }),
    );
  });

  it("returns debug info when requested", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Datalog;

        const { results, debug } = yield* datalog.queryValidated(
          {
            find: ["?name"],
            where: [["?person", ":person/name", "?name"]],
          },
          true,
        );

        expect(results.length).toBe(3);
        expect(debug).toBeDefined();
        expect(debug!.resultCount).toBe(3);
      }),
    );
  });
});

// ─── queryWrapped ──────────────────────────────────────────────────────────

describe("KvDatalogLive - queryWrapped", () => {
  it("executes wrapped queries with pagination", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Datalog;

        const result = yield* datalog.queryWrapped({
          inner: {
            find: ["?name", "?age"],
            where: [
              ["?person", ":person/name", "?name"],
              ["?person", ":person/age", "?age"],
            ],
          },
          orderBy: [{ variable: "?name", direction: "asc" }],
          limit: 2,
          includeCount: true,
        });

        expect(result.results.length).toBe(2);
        expect(result.totalCount).toBe(3);
      }),
    );
  });

  it("applies wrapper filters", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Datalog;

        const result = yield* datalog.queryWrapped({
          inner: {
            find: ["?name", "?age"],
            where: [
              ["?person", ":person/name", "?name"],
              ["?person", ":person/age", "?age"],
            ],
          },
          filters: [{ column: "?name", op: "ilike", value: "%li%" }],
        });

        // Alice and Charlie match "%li%"
        expect(result.results.length).toBe(2);
      }),
    );
  });
});

// ─── explain ───────────────────────────────────────────────────────────────

describe("KvDatalogLive - explain", () => {
  it("returns a query plan without executing", async () => {
    await runTest(
      Effect.gen(function* () {
        const datalog = yield* Datalog;

        const { queryPlan } = yield* datalog.explain({
          find: ["?name"],
          where: [["?p", ":name", "?name"]],
        });

        expect(queryPlan.backend).toBe("kv-store");
        expect(queryPlan.steps.length).toBe(1);
        expect(queryPlan.steps[0]!.label).toBe("main");
      }),
    );
  });

  it("returns a plan for wrapped queries", async () => {
    await runTest(
      Effect.gen(function* () {
        const datalog = yield* Datalog;

        const { queryPlan } = yield* datalog.explainWrapped({
          inner: {
            find: ["?name"],
            where: [["?p", ":name", "?name"]],
          },
          limit: 10,
        });

        expect(queryPlan.backend).toBe("kv-store");
      }),
    );
  });
});
