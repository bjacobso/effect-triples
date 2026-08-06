/**
 * Datalog-query tests for the KV-backed Triples service.
 *
 * These tests verify the KV-backed Datalog engine works correctly when
 * accessed through the standard Triples API.
 */

import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { Triples } from "../../../src/store/Triples.js";
import { KvTriplesLive } from "../../../src/kv/layers/KvTriplesLive.js";
import { KvBackend } from "../../../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../../../src/kv/kv/InMemoryKvBackend.js";
import { TripleStoreRuntimeLayer } from "../../../src/store/TripleStoreRuntime.js";

// ─── Test setup ────────────────────────────────────────────────────────────

const str = (value: string) => ({ type: "string" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const refVal = (value: string) => ({ type: "ref" as const, value });

// Fresh KV-backed Triples layer per test.
const makeTestLayer = () => {
  const freshKvBackend = Layer.effect(
    KvBackend,
    Effect.sync(() => makeTestKvBackend()),
  );
  return KvTriplesLive.pipe(Layer.provide(TripleStoreRuntimeLayer), Layer.provide(freshKvBackend));
};

const runTest = <A, E>(effect: Effect.Effect<A, E, Triples>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, makeTestLayer()));

// Shared seed data
const seedPeople = Effect.gen(function* () {
  const store = yield* Triples;
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

describe("KvTriplesLive - query", () => {
  it("executes a simple pattern query", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Triples;

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
        const datalog = yield* Triples;

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
        const datalog = yield* Triples;

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
        const datalog = yield* Triples;

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

// ─── query ─────────────────────────────────────────────────────────────────

describe("KvTriplesLive - query", () => {
  it("executes typed queries", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Triples;

        const { results } = yield* datalog.query({
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
        const datalog = yield* Triples;

        const { results, debug } = yield* datalog.query(
          {
            find: ["?name"],
            where: [["?person", ":person/name", "?name"]],
          },
          { debug: true },
        );

        expect(results.length).toBe(3);
        expect(debug).toBeDefined();
        expect(debug!.resultCount).toBe(3);
      }),
    );
  });
});

// ─── queryPage ─────────────────────────────────────────────────────────────

describe("KvTriplesLive - queryPage", () => {
  it("executes wrapped queries with pagination", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedPeople;
        const datalog = yield* Triples;

        const result = yield* datalog.queryPage({
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
        const datalog = yield* Triples;

        const result = yield* datalog.queryPage({
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

describe("KvTriplesLive - explain", () => {
  it("returns a query plan without executing", async () => {
    await runTest(
      Effect.gen(function* () {
        const datalog = yield* Triples;

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
        const datalog = yield* Triples;

        const { queryPlan } = yield* datalog.explainPage({
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
