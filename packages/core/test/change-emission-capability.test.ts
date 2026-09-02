/**
 * Tests for ChangeEmissionCapability — verifies that change events emitted
 * by retract operations contain the correct entityId (not the triple's
 * primary key).
 */
import { describe, it, expect } from "vitest";
import { Effect, Option } from "effect";
import type { TriplesService, Triple, TripleId, EntityId } from "../src/index.js";
import type { ChangeEmitterService, ChangeEvent } from "../src/store/ChangeEmitter.js";
import { makeChangeEmissionCapability } from "../src/store/ChangeEmissionCapability.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRIPLE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as TripleId;
const ENTITY_ID = "employee:alice" as EntityId;
const ATTRIBUTE = ":employee/name";
const liveNow = () => Date.now();

function fakeTriple(overrides?: Partial<Triple>): Triple {
  return {
    id: TRIPLE_ID,
    entityId: ENTITY_ID,
    attribute: ATTRIBUTE,
    value: { type: "string", value: "Alice" },
    recordedAt: Date.now(),
    createdBy: Option.none(),
    retractedAt: Option.none(),
    entityType: Option.some("Employee"),
    schemaVersion: Option.none(),
    txId: Option.none(),
    retractTxId: Option.none(),
    ...overrides,
  } as Triple;
}

function stubStore(triple: Triple | null): TriplesService {
  let lastOperations: ReadonlyArray<
    | { readonly op: "assert"; readonly entityId: string; readonly attribute: string }
    | { readonly op: "retract"; readonly id: string }
  > = [];
  return {
    assert: () => Effect.succeed(triple ?? fakeTriple()),
    assertBatch: () => Effect.succeed([]),
    retract: () => Effect.void,
    retractByPattern: () => Effect.succeed(0),
    transact: (operations) => {
      lastOperations = operations as typeof lastOperations;
      return Effect.succeed({ txId: "tx-1", position: 1, instant: 1, triples: [], retracted: 1 });
    },
    get: () => Effect.succeed(triple),
    entity: () => Effect.succeed([]),
    entities: () => Effect.succeed([]),
    match: () => Effect.succeed([]),
    matchAsOf: () => Effect.succeed([]),
    history: () => Effect.succeed([]),
    transaction: () =>
      Effect.succeed({
        txId: "tx-1",
        position: 1,
        instant: 1,
        changes: lastOperations.flatMap((operation) => {
          if (operation.op === "assert") {
            return [
              {
                op: "assert" as const,
                tripleId: "asserted",
                entityId: operation.entityId,
                attribute: operation.attribute,
              },
            ];
          }
          return triple
            ? [
                {
                  op: "retract" as const,
                  tripleId: operation.id,
                  entityId: triple.entityId,
                  attribute: triple.attribute,
                },
              ]
            : [];
        }),
      }),
    transactionsByCommand: () => Effect.succeed([]),
    transactions: () => Effect.succeed({ transactions: [] }),
    query: () => Effect.succeed({ results: [] }),
    queryPage: () => Effect.succeed({ results: [] }),
    explain: () => Effect.succeed({ queryPlan: { backend: "test", steps: [] } }),
    explainPage: () => Effect.succeed({ queryPlan: { backend: "test", steps: [] } }),
    withTransaction: (effect) => effect,
  };
}

const wrapStore = (
  store: TriplesService,
  emitter: ChangeEmitterService,
  now: () => number,
): TriplesService => makeChangeEmissionCapability(emitter, Effect.sync(now)).wrap(store);

function spyEmitter(): { emitter: ChangeEmitterService; events: ChangeEvent[] } {
  const events: ChangeEvent[] = [];
  return {
    events,
    emitter: {
      emit: (event) => {
        events.push(event);
        return Effect.void;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChangeEmissionCapability", () => {
  describe("retract (by ID)", () => {
    it("emits change with correct entityId and attribute from the triple", async () => {
      const triple = fakeTriple();
      const store = stubStore(triple);
      const { emitter, events } = spyEmitter();
      const wrapped = wrapStore(store, emitter, liveNow);

      await Effect.runPromise(wrapped.retract(TRIPLE_ID));

      expect(events).toHaveLength(1);
      expect(events[0].changes).toHaveLength(1);
      expect(events[0].changes[0]).toMatchObject({
        operation: "retract",
        entityId: ENTITY_ID,
        attribute: ATTRIBUTE,
      });
    });

    it("does not emit a wildcard invalidation when no triple was retracted", async () => {
      const store = stubStore(null);
      const { emitter, events } = spyEmitter();
      const wrapped = wrapStore(store, emitter, liveNow);

      await Effect.runPromise(wrapped.retract(TRIPLE_ID));

      expect(events).toHaveLength(1);
      expect(events[0].changes).toEqual([]);
    });
  });

  describe("transact with retract op", () => {
    it("emits change with correct entityId from pre-fetched triple", async () => {
      const triple = fakeTriple();
      const store = stubStore(triple);
      const { emitter, events } = spyEmitter();
      const wrapped = wrapStore(store, emitter, liveNow);

      await Effect.runPromise(wrapped.transact([{ op: "retract", id: TRIPLE_ID as string }]));

      expect(events).toHaveLength(1);
      expect(events[0].changes).toHaveLength(1);
      expect(events[0].changes[0]).toMatchObject({
        operation: "retract",
        entityId: ENTITY_ID,
        attribute: ATTRIBUTE,
      });
      expect(events[0].txId).toBe("tx-1");
    });

    it("uses the committed envelope and omits a retract that changed nothing", async () => {
      const store = stubStore(null);
      const { emitter, events } = spyEmitter();
      const wrapped = wrapStore(store, emitter, liveNow);

      await Effect.runPromise(wrapped.transact([{ op: "retract", id: TRIPLE_ID as string }]));

      expect(events[0].changes).toEqual([]);
    });

    it("handles mixed assert and retract operations", async () => {
      const triple = fakeTriple();
      const store = stubStore(triple);
      const { emitter, events } = spyEmitter();
      const wrapped = wrapStore(store, emitter, liveNow);

      await Effect.runPromise(
        wrapped.transact([
          {
            op: "assert",
            entityId: "employee:bob",
            attribute: ":employee/age",
            value: { type: "number", value: 30 },
          },
          { op: "retract", id: TRIPLE_ID as string },
        ]),
      );

      expect(events).toHaveLength(1);
      expect(events[0].changes).toHaveLength(2);

      // Assert op should have its own entityId
      expect(events[0].changes[0]).toMatchObject({
        operation: "assert",
        entityId: "employee:bob",
        attribute: ":employee/age",
      });

      // Retract op should have the triple's entityId, not the triple's primary key
      expect(events[0].changes[1]).toMatchObject({
        operation: "retract",
        entityId: ENTITY_ID,
        attribute: ATTRIBUTE,
      });
    });
  });

  describe("assert (sanity check)", () => {
    it("emits change with correct entityId from input", async () => {
      const store = stubStore(fakeTriple());
      const { emitter, events } = spyEmitter();
      const wrapped = wrapStore(store, emitter, liveNow);

      await Effect.runPromise(
        wrapped.assert({
          entityId: "employee:alice",
          attribute: ":employee/name",
          value: { type: "string", value: "Alice" },
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0].changes[0]).toMatchObject({
        operation: "assert",
        entityId: "employee:alice",
        attribute: ":employee/name",
      });
    });

    it("uses injected clock when write metadata is unavailable", async () => {
      const store = stubStore(fakeTriple());
      const { emitter, events } = spyEmitter();
      let ts = 10;
      const wrapped = wrapStore(store, emitter, () => {
        ts += 5;
        return ts;
      });

      await Effect.runPromise(wrapped.assertBatch([]));

      expect(events).toHaveLength(1);
      expect(events[0].timestamp).toBe(15);
    });

    it("uses triple metadata for assert event txId/timestamp", async () => {
      const store = stubStore(
        fakeTriple({
          recordedAt: 123,
          txId: Option.some("tx:meta"),
        }),
      );
      const { emitter, events } = spyEmitter();
      const wrapped = wrapStore(store, emitter, () => 999);

      await Effect.runPromise(
        wrapped.assert({
          entityId: "employee:alice",
          attribute: ":employee/name",
          value: { type: "string", value: "Alice" },
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0].txId).toBe("tx:meta");
      expect(events[0].timestamp).toBe(123);
    });
  });
});
