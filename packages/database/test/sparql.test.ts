import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { TripleStore, Sparql, SparqlLive, string, number, ref } from "../src/index.js";
import { SqliteTestLayer } from "./fixtures/SqliteTestLayer.js";

// Combined test layer: Sparql + TripleStore + SQLite
const TestLayer = SparqlLive.pipe(Layer.provideMerge(SqliteTestLayer));

/**
 * Test data setup:
 *
 * People:
 * - p1: Alice, age 30, email alice@example.com, status active
 * - p2: Bob, age 25, status inactive (no email)
 * - p3: Charlie, age 35 (no status, no email)
 * - p4: Diana, age 28, email diana@example.com, status active
 *
 * Departments:
 * - d1: Engineering, budget 1000000
 * - d2: Marketing, budget 500000
 *
 * Employment:
 * - p1 works in d1
 * - p2 works in d1
 * - p3 works in d2
 * - p4 works in d2
 */
const setupTestData = Effect.gen(function* () {
  const store = yield* TripleStore;

  // People
  yield* store.assertBatch([
    { entityId: "p1", attribute: ":name", value: string("Alice"), entityType: "Person" },
    { entityId: "p1", attribute: ":age", value: number(30), entityType: "Person" },
    {
      entityId: "p1",
      attribute: ":email",
      value: string("alice@example.com"),
      entityType: "Person",
    },
    { entityId: "p1", attribute: ":status", value: string("active"), entityType: "Person" },

    { entityId: "p2", attribute: ":name", value: string("Bob"), entityType: "Person" },
    { entityId: "p2", attribute: ":age", value: number(25), entityType: "Person" },
    { entityId: "p2", attribute: ":status", value: string("inactive"), entityType: "Person" },
    // p2 has no email

    { entityId: "p3", attribute: ":name", value: string("Charlie"), entityType: "Person" },
    { entityId: "p3", attribute: ":age", value: number(35), entityType: "Person" },
    // p3 has no status or email

    { entityId: "p4", attribute: ":name", value: string("Diana"), entityType: "Person" },
    { entityId: "p4", attribute: ":age", value: number(28), entityType: "Person" },
    {
      entityId: "p4",
      attribute: ":email",
      value: string("diana@example.com"),
      entityType: "Person",
    },
    { entityId: "p4", attribute: ":status", value: string("active"), entityType: "Person" },
  ]);

  // Departments
  yield* store.assertBatch([
    { entityId: "d1", attribute: ":name", value: string("Engineering"), entityType: "Department" },
    { entityId: "d1", attribute: ":budget", value: number(1000000), entityType: "Department" },

    { entityId: "d2", attribute: ":name", value: string("Marketing"), entityType: "Department" },
    { entityId: "d2", attribute: ":budget", value: number(500000), entityType: "Department" },
  ]);

  // Employment relationships
  yield* store.assertBatch([
    { entityId: "p1", attribute: ":department", value: ref("d1"), entityType: "Person" },
    { entityId: "p2", attribute: ":department", value: ref("d1"), entityType: "Person" },
    { entityId: "p3", attribute: ":department", value: ref("d2"), entityType: "Person" },
    { entityId: "p4", attribute: ":department", value: ref("d2"), entityType: "Person" },
  ]);
});

describe("SPARQL Integration", () => {
  describe("SELECT queries", () => {
    it("should find all names", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?name"] },
            where: [["?person", ":name", "?name"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(6); // 4 people + 2 departments
        expect(result.results.results).toContainEqual({ "?name": "Alice" });
        expect(result.results.results).toContainEqual({ "?name": "Engineering" });
      }
    });

    it("should find by specific value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?person"] },
            where: [["?person", ":name", "Alice"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(1);
        expect(result.results.results[0]).toEqual({ "?person": "p1" });
      }
    });

    it("should return multiple attributes with JOIN", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?name", "?age"] },
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(4); // 4 people have both name and age
        expect(result.results.results).toContainEqual({ "?name": "Alice", "?age": 30 });
        expect(result.results.results).toContainEqual({ "?name": "Bob", "?age": 25 });
      }
    });

    it("should follow references", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?personName", "?deptName"] },
            where: [
              ["?person", ":name", "?personName"],
              ["?person", ":department", "?dept"],
              ["?dept", ":name", "?deptName"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(4);
        expect(result.results.results).toContainEqual({
          "?personName": "Alice",
          "?deptName": "Engineering",
        });
        expect(result.results.results).toContainEqual({
          "?personName": "Diana",
          "?deptName": "Marketing",
        });
      }
    });
  });

  describe("OPTIONAL pattern", () => {
    it("should include NULL for missing optional attributes", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?name", "?email"] },
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"], // Filter to people only (have age)
              { optional: [["?person", ":email", "?email"]] },
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(4);
        // Alice and Diana have emails
        expect(result.results.results).toContainEqual({
          "?name": "Alice",
          "?email": "alice@example.com",
        });
        expect(result.results.results).toContainEqual({
          "?name": "Diana",
          "?email": "diana@example.com",
        });
        // Bob and Charlie don't have emails - they should still appear
        const bob = result.results.results.find((r) => r["?name"] === "Bob");
        expect(bob).toBeDefined();
        expect(bob?.["?email"]).toBeUndefined(); // NULL values become undefined
      }
    });
  });

  describe("FILTER expressions", () => {
    it("should filter with >= predicate", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?name", "?age"] },
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              { filter: { op: ">=", left: "?age", right: 30 } },
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(2); // Alice (30), Charlie (35)
        expect(result.results.results).toContainEqual({ "?name": "Alice", "?age": 30 });
        expect(result.results.results).toContainEqual({ "?name": "Charlie", "?age": 35 });
      }
    });

    it("should filter with != predicate", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?name"] },
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              { filter: { op: "!=", left: "?name", right: "Bob" } },
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(3);
        expect(result.results.results).not.toContainEqual({ "?name": "Bob" });
      }
    });

    it("should filter with contains function", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?name"] },
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              { filter: { fn: "contains", args: ["?name", "li"] } },
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(2); // Alice, Charlie
        expect(result.results.results).toContainEqual({ "?name": "Alice" });
        expect(result.results.results).toContainEqual({ "?name": "Charlie" });
      }
    });
  });

  describe("ORDER BY, LIMIT, OFFSET", () => {
    it("should order results ascending", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?name", "?age"] },
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
            ],
            orderBy: [{ variable: "?age", direction: "asc" }],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(4);
        expect(result.results.results[0]).toEqual({ "?name": "Bob", "?age": 25 });
        expect(result.results.results[3]).toEqual({ "?name": "Charlie", "?age": 35 });
      }
    });

    it("should order results descending", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?name", "?age"] },
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
            ],
            orderBy: [{ variable: "?age", direction: "desc" }],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(4);
        expect(result.results.results[0]).toEqual({ "?name": "Charlie", "?age": 35 });
        expect(result.results.results[3]).toEqual({ "?name": "Bob", "?age": 25 });
      }
    });

    it("should limit results", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?name"] },
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
            ],
            orderBy: [{ variable: "?name", direction: "asc" }],
            limit: 2,
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(2);
        expect(result.results.results[0]).toEqual({ "?name": "Alice" });
        expect(result.results.results[1]).toEqual({ "?name": "Bob" });
      }
    });

    it("should skip results with offset", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?name"] },
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
            ],
            orderBy: [{ variable: "?name", direction: "asc" }],
            limit: 2,
            offset: 2,
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(2);
        expect(result.results.results[0]).toEqual({ "?name": "Charlie" });
        expect(result.results.results[1]).toEqual({ "?name": "Diana" });
      }
    });
  });

  describe("ASK queries", () => {
    it("should return true when match exists", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.ask({
            form: "ask",
            where: [["?person", ":name", "Alice"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBe(true);
    });

    it("should return false when no match exists", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.ask({
            form: "ask",
            where: [["?person", ":name", "Zoe"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBe(false);
    });

    it("should handle complex ASK with multiple patterns", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          // Is there anyone named Alice who is 30 years old?
          return yield* sparql.ask({
            form: "ask",
            where: [
              ["?person", ":name", "Alice"],
              ["?person", ":age", 30],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBe(true);
    });
  });

  describe("aggregation", () => {
    it("should count results", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?count"] },
            where: [["?person", ":age", "?age"]],
            aggregate: [["count", "?person", "?count"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(1);
        expect(result.results.results[0]["?count"]).toBe(4);
      }
    });

    it("should compute average", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.query({
            form: "select",
            select: { variables: ["?avgAge"] },
            where: [["?person", ":age", "?age"]],
            aggregate: [["avg", "?age", "?avgAge"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results.type).toBe("select");
      if (result.results.type === "select") {
        expect(result.results.results).toHaveLength(1);
        // (25 + 28 + 30 + 35) / 4 = 29.5
        expect(result.results.results[0]["?avgAge"]).toBe(29.5);
      }
    });
  });

  describe("select helper", () => {
    it("should return just the bindings", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const sparql = yield* Sparql;

          return yield* sparql.select({
            form: "select",
            select: { variables: ["?name"] },
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
            ],
            orderBy: [{ variable: "?name", direction: "asc" }],
            limit: 2,
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ "?name": "Alice" });
      expect(result[1]).toEqual({ "?name": "Bob" });
    });
  });
});
