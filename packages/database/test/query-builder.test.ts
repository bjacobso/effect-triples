import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  TripleStore,
  TripleStoreLive,
  Query,
  RuntimeServicesLive,
  StorageAdapter,
  TripleStoreRuntimeLayer,
  string,
  number,
} from "../src/index.js";
import { SqliteTestLayer } from "./fixtures/SqliteTestLayer.js";
import { SqliteAdapterLive } from "../sqlite/src/index.js";

const TestLayer = SqliteTestLayer;
const makeRawQueryCountingLayer = (counter: { count: number; sql: string | null }) => {
  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
  const adapterLayer = SqliteAdapterLive.pipe(Layer.provide(sqliteLayer));
  const countingAdapterLayer = Layer.effect(
    StorageAdapter,
    Effect.gen(function* () {
      const adapter = yield* StorageAdapter;
      return {
        ...adapter,
        rawQuery: <T extends object>(sql: string, params: readonly unknown[]) =>
          Effect.sync(() => {
            counter.count++;
            counter.sql = sql;
          }).pipe(Effect.zipRight(adapter.rawQuery<T>(sql, params))),
      };
    }),
  ).pipe(Layer.provide(adapterLayer));

  return TripleStoreLive.pipe(
    Layer.provide(countingAdapterLayer),
    Layer.provide(TripleStoreRuntimeLayer),
    Layer.provideMerge(RuntimeServicesLive),
  );
};

/**
 * Test data setup:
 *
 * Person entities:
 * - p1: Alice, age 30, status active, has email
 * - p2: Bob, age 25, status inactive, has email
 * - p3: Charlie, age 35, no status, no email
 * - p4: Diana, age 28, status active, has email
 * - p5: Eve, age 22, status pending, no email
 *
 * Company entities (to verify entityType filtering):
 * - c1: Acme, employees 100
 * - c2: Beta, employees 50
 */
const setupTestData = Effect.gen(function* () {
  const store = yield* TripleStore;

  // Person 1: Alice
  yield* store.assertBatch([
    { entityId: "p1", attribute: ":name", value: string("Alice"), entityType: "Person" },
    { entityId: "p1", attribute: ":age", value: number(30), entityType: "Person" },
    { entityId: "p1", attribute: ":status", value: string("active"), entityType: "Person" },
    {
      entityId: "p1",
      attribute: ":email",
      value: string("alice@example.com"),
      entityType: "Person",
    },
  ]);

  // Person 2: Bob
  yield* store.assertBatch([
    { entityId: "p2", attribute: ":name", value: string("Bob"), entityType: "Person" },
    { entityId: "p2", attribute: ":age", value: number(25), entityType: "Person" },
    { entityId: "p2", attribute: ":status", value: string("inactive"), entityType: "Person" },
    { entityId: "p2", attribute: ":email", value: string("bob@example.com"), entityType: "Person" },
  ]);

  // Person 3: Charlie (no status, no email)
  yield* store.assertBatch([
    { entityId: "p3", attribute: ":name", value: string("Charlie"), entityType: "Person" },
    { entityId: "p3", attribute: ":age", value: number(35), entityType: "Person" },
  ]);

  // Person 4: Diana
  yield* store.assertBatch([
    { entityId: "p4", attribute: ":name", value: string("Diana"), entityType: "Person" },
    { entityId: "p4", attribute: ":age", value: number(28), entityType: "Person" },
    { entityId: "p4", attribute: ":status", value: string("active"), entityType: "Person" },
    {
      entityId: "p4",
      attribute: ":email",
      value: string("diana@example.com"),
      entityType: "Person",
    },
  ]);

  // Person 5: Eve (no email)
  yield* store.assertBatch([
    { entityId: "p5", attribute: ":name", value: string("Eve"), entityType: "Person" },
    { entityId: "p5", attribute: ":age", value: number(22), entityType: "Person" },
    { entityId: "p5", attribute: ":status", value: string("pending"), entityType: "Person" },
  ]);

  // Company 1: Acme
  yield* store.assertBatch([
    { entityId: "c1", attribute: ":name", value: string("Acme"), entityType: "Company" },
    { entityId: "c1", attribute: ":employees", value: number(100), entityType: "Company" },
  ]);

  // Company 2: Beta
  yield* store.assertBatch([
    { entityId: "c2", attribute: ":name", value: string("Beta"), entityType: "Company" },
    { entityId: "c2", attribute: ":employees", value: number(50), entityType: "Company" },
  ]);
});

// Helper to get unique entity IDs from triples
const getEntityIds = (triples: readonly { entityId: string }[]): string[] => {
  return [...new Set(triples.map((t) => t.entityId))].sort();
};

describe("QueryBuilder", () => {
  describe("basic queries", () => {
    it("should return all entities of a type when no filters", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const triples = yield* Query.from("Person").run();
          return getEntityIds(triples);
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    });

    it("should only return entities of the specified type", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const triples = yield* Query.from("Company").run();
          return getEntityIds(triples);
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toEqual(["c1", "c2"]);
    });
  });

  describe("filtering", () => {
    describe("equality (=)", () => {
      it("should filter by string equality", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":name", "=", "Alice").run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        expect(result).toEqual(["p1"]);
      });

      it("should filter by number equality", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":age", "=", 30).run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        expect(result).toEqual(["p1"]);
      });
    });

    describe("inequality (!=)", () => {
      it("should filter by string inequality", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":status", "!=", "active").run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Bob (inactive), Eve (pending) - Charlie has no status so not matched
        expect(result).toEqual(["p2", "p5"]);
      });
    });

    describe("greater than (>)", () => {
      it("should filter by greater than", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":age", ">", 28).run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Alice (30), Charlie (35)
        expect(result).toEqual(["p1", "p3"]);
      });
    });

    describe("greater than or equal (>=)", () => {
      it("should filter by greater than or equal", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":age", ">=", 28).run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Alice (30), Charlie (35), Diana (28)
        expect(result).toEqual(["p1", "p3", "p4"]);
      });
    });

    describe("less than (<)", () => {
      it("should filter by less than", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":age", "<", 25).run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Eve (22)
        expect(result).toEqual(["p5"]);
      });
    });

    describe("less than or equal (<=)", () => {
      it("should filter by less than or equal", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":age", "<=", 25).run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Bob (25), Eve (22)
        expect(result).toEqual(["p2", "p5"]);
      });
    });

    describe("contains", () => {
      it("should filter by string contains", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":name", "contains", "li").run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Alice, Charlie
        expect(result).toEqual(["p1", "p3"]);
      });
    });

    describe("startsWith", () => {
      it("should filter by string startsWith", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":name", "startsWith", "A").run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Alice
        expect(result).toEqual(["p1"]);
      });
    });

    describe("in", () => {
      it("should filter by multiple values", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person")
              .where(":status", "in", ["active", "pending"])
              .run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Alice (active), Diana (active), Eve (pending)
        expect(result).toEqual(["p1", "p4", "p5"]);
      });
    });

    describe("exists", () => {
      it("should filter by attribute existence", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":email", "exists").run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Alice, Bob, Diana (have email)
        expect(result).toEqual(["p1", "p2", "p4"]);
      });
    });

    describe("notExists", () => {
      it("should filter by attribute non-existence", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person").where(":email", "notExists").run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Charlie, Eve (no email)
        expect(result).toEqual(["p3", "p5"]);
      });
    });

    describe("multiple filters", () => {
      it("should combine multiple filters (implicit AND)", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person")
              .where(":age", ">=", 25)
              .where(":status", "=", "active")
              .run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Alice (30, active), Diana (28, active)
        expect(result).toEqual(["p1", "p4"]);
      });

      it("should combine three filters", async () => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* setupTestData;
            const triples = yield* Query.from("Person")
              .where(":age", ">=", 25)
              .where(":status", "=", "active")
              .where(":email", "exists")
              .run();
            return getEntityIds(triples);
          }).pipe(Effect.provide(TestLayer)),
        );

        // Alice (30, active, has email), Diana (28, active, has email)
        expect(result).toEqual(["p1", "p4"]);
      });
    });
  });

  describe("sorting", () => {
    it("should sort ascending by string attribute", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const triples = yield* Query.from("Person").orderBy(":name", "asc").run();

          // Get names in order (by first occurrence of each entity)
          const seen = new Set<string>();
          const orderedIds: string[] = [];
          for (const t of triples) {
            if (!seen.has(t.entityId)) {
              seen.add(t.entityId);
              orderedIds.push(t.entityId);
            }
          }
          return orderedIds;
        }).pipe(Effect.provide(TestLayer)),
      );

      // Alice, Bob, Charlie, Diana, Eve (alphabetical)
      expect(result).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    });

    it("should sort descending by string attribute", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const triples = yield* Query.from("Person").orderBy(":name", "desc").run();

          const seen = new Set<string>();
          const orderedIds: string[] = [];
          for (const t of triples) {
            if (!seen.has(t.entityId)) {
              seen.add(t.entityId);
              orderedIds.push(t.entityId);
            }
          }
          return orderedIds;
        }).pipe(Effect.provide(TestLayer)),
      );

      // Eve, Diana, Charlie, Bob, Alice (reverse alphabetical)
      expect(result).toEqual(["p5", "p4", "p3", "p2", "p1"]);
    });
  });

  describe("pagination", () => {
    it("should limit results", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const triples = yield* Query.from("Person").orderBy(":name", "asc").limit(2).run();
          return getEntityIds(triples);
        }).pipe(Effect.provide(TestLayer)),
      );

      // First 2: Alice, Bob
      expect(result).toEqual(["p1", "p2"]);
    });

    it("should offset results", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const triples = yield* Query.from("Person").orderBy(":name", "asc").offset(2).run();
          return getEntityIds(triples);
        }).pipe(Effect.provide(TestLayer)),
      );

      // Skip first 2, get: Charlie, Diana, Eve
      expect(result).toEqual(["p3", "p4", "p5"]);
    });

    it("should combine limit and offset", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const triples = yield* Query.from("Person")
            .orderBy(":name", "asc")
            .limit(2)
            .offset(1)
            .run();
          return getEntityIds(triples);
        }).pipe(Effect.provide(TestLayer)),
      );

      // Skip 1, take 2: Bob, Charlie
      expect(result).toEqual(["p2", "p3"]);
    });

    it("should apply pagination to entities while returning all live triples for each match", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const triples = yield* Query.from("Person")
            .where(":status", "=", "active")
            .orderBy(":name", "asc")
            .limit(1)
            .run();

          return {
            entityIds: getEntityIds(triples),
            attributes: triples.map((triple) => triple.attribute).sort(),
          };
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.entityIds).toEqual(["p1"]);
      expect(result.attributes).toEqual([":age", ":email", ":name", ":status"]);
    });

    it("should execute query builder as a single raw storage query", async () => {
      const counter = { count: 0, sql: null as string | null };
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          counter.count = 0;
          counter.sql = null;

          const triples = yield* Query.from("Person")
            .where(":status", "=", "active")
            .orderBy(":name", "asc")
            .limit(1)
            .run();

          return {
            entityIds: getEntityIds(triples),
            rawQueryCount: counter.count,
            sql: counter.sql,
          };
        }).pipe(Effect.provide(makeRawQueryCountingLayer(counter))),
      );

      expect(result.entityIds).toEqual(["p1"]);
      expect(result.rawQueryCount).toBe(1);
      expect(result.sql).toContain("WITH matched_entities AS");
      expect(result.sql).toContain("paged_entities AS");
    });
  });

  describe("combined queries", () => {
    it("should filter + sort + paginate together", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const triples = yield* Query.from("Person")
            .where(":status", "=", "active")
            .orderBy(":name", "asc")
            .limit(1)
            .run();
          return getEntityIds(triples);
        }).pipe(Effect.provide(TestLayer)),
      );

      // Active people: Alice, Diana. Sorted: Alice, Diana. Limit 1: Alice
      expect(result).toEqual(["p1"]);
    });

    it("should return empty array when no matches", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const triples = yield* Query.from("Person").where(":age", ">", 100).run();
          return triples;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toEqual([]);
    });
  });

  describe("validation", () => {
    it("should throw error for attribute without : prefix", async () => {
      expect(() => {
        Query.from("Person").where("age", ">=", 21);
      }).toThrow('Attribute must start with ":"');
    });

    it("should throw error for orderBy attribute without : prefix", async () => {
      expect(() => {
        Query.from("Person").orderBy("name", "asc");
      }).toThrow('Attribute must start with ":"');
    });
  });

  describe("getState", () => {
    it("should return the current query state", () => {
      const query = Query.from("Person")
        .where(":age", ">=", 21)
        .where(":status", "=", "active")
        .orderBy(":name", "asc")
        .limit(10)
        .offset(5);

      const state = query.getState();

      expect(state.entityType).toBe("Person");
      expect(state.filters).toHaveLength(2);
      expect(state.sorts).toHaveLength(1);
      expect(state.limit).toBe(10);
      expect(state.offset).toBe(5);
    });
  });
});
