import { describe, it, expect } from "vitest";
import { Effect, Layer, Option } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  Triples,
  TriplesLive,
  CurrentDialect,
  SqliteDialect,
  TripleStoreRuntime,
  DeterministicTripleStoreRuntimeLive,
  TxAttributes,
  string,
  number,
  boolean,
  ref,
} from "@bjacobso/triplex";
import { SqlQueryExecutorLive } from "@bjacobso/triplex-sql";
import { SqliteAdapterLive } from "@bjacobso/triplex-sqlite";
import type { EntityId, TripleId } from "@bjacobso/triplex";
import { SqliteTestLayer } from "./fixtures/SqliteTestLayer.js";

const TestLayer = SqliteTestLayer;
const makeRuntimeTestLayer = (runtimeLayer: Layer.Layer<TripleStoreRuntime>) =>
  TriplesLive.pipe(
    Layer.provideMerge(SqlQueryExecutorLive),
    Layer.provideMerge(SqliteAdapterLive),
    Layer.provideMerge(Layer.succeed(CurrentDialect, SqliteDialect)),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
    Layer.provide(runtimeLayer),
  );

describe("Triples", () => {
  describe("assert", () => {
    it("should create a triple with string value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triple = yield* store.assert({
            entityId: "person-1",
            attribute: ":name",
            value: string("Alice"),
            entityType: "Person",
          });

          expect(triple.id).toBeDefined();
          expect(triple.entityId).toBe("person-1");
          expect(triple.attribute).toBe(":name");
          expect(triple.value).toEqual({ type: "string", value: "Alice" });
          expect(Option.isSome(triple.entityType)).toBe(true);
          expect(Option.getOrNull(triple.entityType)).toBe("Person");

          return triple;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });

    it("should create a triple with number value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triple = yield* store.assert({
            entityId: "person-1",
            attribute: ":age",
            value: number(30),
          });

          expect(triple.value).toEqual({ type: "number", value: 30 });
          return triple;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });

    it("should create a triple with boolean value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triple = yield* store.assert({
            entityId: "person-1",
            attribute: ":active",
            value: boolean(true),
          });

          expect(triple.value).toEqual({ type: "boolean", value: true });
          return triple;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });

    it("should create a triple with ref value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triple = yield* store.assert({
            entityId: "person-1",
            attribute: ":works-at",
            value: ref("company-1"),
          });

          expect(triple.value).toEqual({ type: "ref", value: "company-1" });
          return triple;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });
  });

  describe("assertBatch", () => {
    it("should create multiple triples", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triples = yield* store.assertBatch([
            { entityId: "person-1", attribute: ":name", value: string("Alice") },
            { entityId: "person-1", attribute: ":age", value: number(30) },
            { entityId: "person-1", attribute: ":active", value: boolean(true) },
          ]);

          expect(triples).toHaveLength(3);
          return triples;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(3);
    });
  });

  describe("getTriple", () => {
    it("should retrieve a triple by id", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const created = yield* store.assert({
            entityId: "person-1",
            attribute: ":name",
            value: string("Alice"),
          });

          const retrieved = yield* store.get(created.id);

          expect(retrieved).not.toBeNull();
          expect(retrieved?.id).toBe(created.id);
          expect(retrieved?.value).toEqual({ type: "string", value: "Alice" });
          return retrieved;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });

    it("should return null for non-existent triple", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const retrieved = yield* store.get("non-existent" as TripleId);
          return retrieved;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeNull();
    });
  });

  describe("getEntity", () => {
    it("should retrieve all triples for an entity", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.assertBatch([
            { entityId: "person-1", attribute: ":name", value: string("Alice") },
            { entityId: "person-1", attribute: ":age", value: number(30) },
            { entityId: "person-2", attribute: ":name", value: string("Bob") },
          ]);

          const triples = yield* store.entity("person-1" as EntityId);

          expect(triples).toHaveLength(2);
          return triples;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
    });
  });

  describe("retract", () => {
    it("should soft-delete a triple", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const created = yield* store.assert({
            entityId: "person-1",
            attribute: ":name",
            value: string("Alice"),
          });

          yield* store.retract(created.id);

          const retrieved = yield* store.get(created.id);
          expect(retrieved).toBeNull();

          // But history should still have it
          const history = yield* store.history("person-1" as EntityId);
          expect(history).toHaveLength(1);
          expect(Option.isSome(history[0]!.retractedAt)).toBe(true);

          return history;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(1);
    });
  });

  describe("runtime injection", () => {
    it("should use injected clock and tx-id generator for writes", async () => {
      let now = 1_000;
      let txCounter = 0;
      let tripleCounter = 0;

      const RuntimeLayer = Layer.succeed(TripleStoreRuntime, {
        now: Effect.sync(() => {
          now += 10;
          return now;
        }),
        nextTripleId: Effect.sync(() => `triple:det-${++tripleCounter}` as TripleId),
        nextTxId: Effect.sync(() => `tx:det-${++txCounter}`),
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const batch = yield* store.assertBatch([
            { entityId: "person-1", attribute: ":name", value: string("Alice") },
            { entityId: "person-1", attribute: ":age", value: number(30) },
          ]);

          expect(batch).toHaveLength(2);
          expect(batch[0]!.createdAt).toBe(1010);
          expect(batch[1]!.createdAt).toBe(1010);
          expect(batch[0]!.id).toBe("triple:det-1");
          expect(batch[1]!.id).toBe("triple:det-2");
          expect(Option.getOrNull(batch[0]!.txId)).toBe("tx:det-1");

          const tx = yield* store.transact([
            {
              op: "assert",
              entityId: "person-2",
              attribute: ":name",
              value: string("Bob"),
            },
          ]);

          expect(tx.txId).toBe("tx:det-2");

          const txMeta = yield* store.match({ entityId: tx.txId, attribute: TxAttributes.INSTANT });
          expect(txMeta).toHaveLength(1);
          expect(txMeta[0]!.id).toBe("triple:det-4");
          expect(txMeta[0]!.value).toEqual({ type: "datetime", value: 1020 });

          yield* store.retract(batch[0]!.id);
          const history = yield* store.history("person-1" as EntityId);
          const retracted = history.find((triple) => triple.id === batch[0]!.id);
          expect(retracted).toBeDefined();
          expect(Option.getOrNull(retracted!.retractTxId)).toBe("tx:det-3");
          expect(Option.getOrNull(retracted!.retractedAt)).toBe(1030);
        }).pipe(Effect.provide(makeRuntimeTestLayer(RuntimeLayer))),
      );

      expect(result).toBeUndefined();
    });

    it("should provide deterministic clock, tx ids, and triple ids", async () => {
      const RuntimeLayer = DeterministicTripleStoreRuntimeLive({
        now: 123_456,
        idSeed: "unit",
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triple = yield* store.assert({
            entityId: "person-1",
            attribute: ":name",
            value: string("Alice"),
          });

          expect(triple.id).toBe("_triple/unit-000001");
          expect(triple.createdAt).toBe(123_456);
          expect(Option.getOrNull(triple.txId)).toBe("_tx/unit-000001");

          const tx = yield* store.transact([
            { op: "assert", entityId: "person-2", attribute: ":name", value: string("Bob") },
          ]);

          expect(tx.txId).toBe("_tx/unit-000002");
          expect(tx.triples[0]!.id).toBe("_triple/unit-000002");
        }).pipe(Effect.provide(makeRuntimeTestLayer(RuntimeLayer))),
      );
    });
  });

  describe("query", () => {
    it("should query by entity type", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.assertBatch([
            {
              entityId: "person-1",
              attribute: ":name",
              value: string("Alice"),
              entityType: "Person",
            },
            {
              entityId: "person-2",
              attribute: ":name",
              value: string("Bob"),
              entityType: "Person",
            },
            {
              entityId: "company-1",
              attribute: ":name",
              value: string("Acme"),
              entityType: "Company",
            },
          ]);

          const people = yield* store.match({ entityType: "Person" });

          expect(people).toHaveLength(2);
          return people;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
    });

    it("should query by attribute", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.assertBatch([
            { entityId: "person-1", attribute: ":name", value: string("Alice") },
            { entityId: "person-1", attribute: ":age", value: number(30) },
            { entityId: "person-2", attribute: ":name", value: string("Bob") },
          ]);

          const names = yield* store.match({ attribute: ":name" });

          expect(names).toHaveLength(2);
          return names;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
    });

    it("should query by value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.assertBatch([
            { entityId: "person-1", attribute: ":name", value: string("Alice") },
            { entityId: "person-2", attribute: ":name", value: string("Alice") },
            { entityId: "person-3", attribute: ":name", value: string("Bob") },
          ]);

          const alices = yield* store.match({ value: string("Alice") });

          expect(alices).toHaveLength(2);
          return alices;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
    });
  });

  describe("time travel", () => {
    it("should query entity state as of a specific time", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          // Create initial state
          const first = yield* store.assert({
            entityId: "person-1",
            attribute: ":name",
            value: string("Alice"),
          });

          const timeAfterFirst = Date.now();

          // Wait a bit to ensure different timestamp
          yield* Effect.sleep("10 millis");

          // Retract and add new value
          yield* store.retract(first.id);
          yield* store.assert({
            entityId: "person-1",
            attribute: ":name",
            value: string("Alice Smith"),
          });

          // Query as of before the change
          const pastState = yield* store.matchAsOf({ entityId: "person-1" }, timeAfterFirst);

          expect(pastState).toHaveLength(1);
          expect(pastState[0]!.value).toEqual({ type: "string", value: "Alice" });

          // Query current state
          const currentState = yield* store.entity("person-1" as EntityId);
          expect(currentState).toHaveLength(1);
          expect(currentState[0]!.value).toEqual({ type: "string", value: "Alice Smith" });

          return { pastState, currentState };
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.pastState).toHaveLength(1);
      expect(result.currentState).toHaveLength(1);
    });

    it("should get full entity history", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const first = yield* store.assert({
            entityId: "person-1",
            attribute: ":name",
            value: string("Alice"),
          });

          yield* Effect.sleep("5 millis");
          yield* store.retract(first.id);

          yield* Effect.sleep("5 millis");
          yield* store.assert({
            entityId: "person-1",
            attribute: ":name",
            value: string("Alice Smith"),
          });

          const history = yield* store.history("person-1" as EntityId);

          expect(history).toHaveLength(2);
          // First one should be retracted
          expect(Option.isSome(history[0]!.retractedAt)).toBe(true);
          // Second one should be active
          expect(Option.isNone(history[1]!.retractedAt)).toBe(true);

          return history;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
    });
  });
});
