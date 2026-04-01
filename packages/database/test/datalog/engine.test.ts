import { describe, it, expect } from "vitest";
import {
  matchPattern,
  querySingle,
  queryWhere,
  actualize,
  querySync,
} from "../../src/datalog/engine.js";
import { evaluatePredicateSync } from "../../src/datalog/predicates.js";
import type {
  SimplifiedTriple,
  Context,
  PatternClause,
  PredicateClause,
} from "../../src/datalog/types.js";

// Sample test data
const sampleTriples: SimplifiedTriple[] = [
  // People
  ["p1", ":name", "Alice"],
  ["p1", ":age", 30],
  ["p1", ":status", "active"],

  ["p2", ":name", "Bob"],
  ["p2", ":age", 25],
  ["p2", ":status", "inactive"],

  ["p3", ":name", "Charlie"],
  ["p3", ":age", 35],
  // p3 has no status

  // Movies
  ["m1", ":title", "The Terminator"],
  ["m1", ":director", "p4"],
  ["m1", ":cast", "p5"],

  ["p4", ":name", "James Cameron"],
  ["p5", ":name", "Arnold Schwarzenegger"],
];

describe("Datalog Engine", () => {
  describe("matchPattern", () => {
    it("should match a pattern with all variables", () => {
      const pattern: PatternClause = ["?e", "?a", "?v"];
      const triple: SimplifiedTriple = ["p1", ":name", "Alice"];
      const context: Context = {};

      const result = matchPattern(pattern, triple, context);

      expect(result).toEqual({
        "?e": "p1",
        "?a": ":name",
        "?v": "Alice",
      });
    });

    it("should match a pattern with some constants", () => {
      const pattern: PatternClause = ["?person", ":name", "Alice"];
      const triple: SimplifiedTriple = ["p1", ":name", "Alice"];
      const context: Context = {};

      const result = matchPattern(pattern, triple, context);

      expect(result).toEqual({ "?person": "p1" });
    });

    it("should return null when constant doesn't match", () => {
      const pattern: PatternClause = ["?person", ":name", "Bob"];
      const triple: SimplifiedTriple = ["p1", ":name", "Alice"];
      const context: Context = {};

      const result = matchPattern(pattern, triple, context);

      expect(result).toBeNull();
    });

    it("should match when bound variable matches triple", () => {
      const pattern: PatternClause = ["?person", ":age", "?age"];
      const triple: SimplifiedTriple = ["p1", ":age", 30];
      const context: Context = { "?person": "p1" };

      const result = matchPattern(pattern, triple, context);

      expect(result).toEqual({ "?person": "p1", "?age": 30 });
    });

    it("should return null when bound variable doesn't match", () => {
      const pattern: PatternClause = ["?person", ":age", "?age"];
      const triple: SimplifiedTriple = ["p2", ":age", 25];
      const context: Context = { "?person": "p1" };

      const result = matchPattern(pattern, triple, context);

      expect(result).toBeNull();
    });

    it("should match pattern with all constants", () => {
      const pattern: PatternClause = ["p1", ":name", "Alice"];
      const triple: SimplifiedTriple = ["p1", ":name", "Alice"];
      const context: Context = {};

      const result = matchPattern(pattern, triple, context);

      expect(result).toEqual({});
    });

    it("should propagate null context", () => {
      const pattern: PatternClause = ["?e", "?a", "?v"];
      const triple: SimplifiedTriple = ["p1", ":name", "Alice"];

      // @ts-expect-error - testing null handling
      const result = matchPattern(pattern, triple, null);

      expect(result).toBeNull();
    });
  });

  describe("querySingle", () => {
    it("should find all matching triples", () => {
      const pattern: PatternClause = ["?person", ":name", "?name"];
      const context: Context = {};

      const results = querySingle(pattern, sampleTriples, context);

      expect(results).toHaveLength(5); // Alice, Bob, Charlie, James, Arnold
      expect(results).toContainEqual({ "?person": "p1", "?name": "Alice" });
      expect(results).toContainEqual({ "?person": "p2", "?name": "Bob" });
    });

    it("should filter by constant value", () => {
      const pattern: PatternClause = ["?person", ":name", "Alice"];
      const context: Context = {};

      const results = querySingle(pattern, sampleTriples, context);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ "?person": "p1" });
    });

    it("should respect bound variables", () => {
      const pattern: PatternClause = ["?person", ":age", "?age"];
      const context: Context = { "?person": "p1" };

      const results = querySingle(pattern, sampleTriples, context);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ "?person": "p1", "?age": 30 });
    });

    it("should return empty array when no matches", () => {
      const pattern: PatternClause = ["?person", ":name", "Nobody"];
      const context: Context = {};

      const results = querySingle(pattern, sampleTriples, context);

      expect(results).toEqual([]);
    });
  });

  describe("evaluatePredicateSync", () => {
    it("should evaluate > correctly", () => {
      const pred: PredicateClause = [">", "?age", 25];

      expect(evaluatePredicateSync(pred, { "?age": 30 })).toBe(true);
      expect(evaluatePredicateSync(pred, { "?age": 25 })).toBe(false);
      expect(evaluatePredicateSync(pred, { "?age": 20 })).toBe(false);
    });

    it("should evaluate >= correctly", () => {
      const pred: PredicateClause = [">=", "?age", 25];

      expect(evaluatePredicateSync(pred, { "?age": 30 })).toBe(true);
      expect(evaluatePredicateSync(pred, { "?age": 25 })).toBe(true);
      expect(evaluatePredicateSync(pred, { "?age": 20 })).toBe(false);
    });

    it("should evaluate < correctly", () => {
      const pred: PredicateClause = ["<", "?age", 30];

      expect(evaluatePredicateSync(pred, { "?age": 25 })).toBe(true);
      expect(evaluatePredicateSync(pred, { "?age": 30 })).toBe(false);
      expect(evaluatePredicateSync(pred, { "?age": 35 })).toBe(false);
    });

    it("should evaluate <= correctly", () => {
      const pred: PredicateClause = ["<=", "?age", 30];

      expect(evaluatePredicateSync(pred, { "?age": 25 })).toBe(true);
      expect(evaluatePredicateSync(pred, { "?age": 30 })).toBe(true);
      expect(evaluatePredicateSync(pred, { "?age": 35 })).toBe(false);
    });

    it("should evaluate = correctly", () => {
      const pred: PredicateClause = ["=", "?status", "active"];

      expect(evaluatePredicateSync(pred, { "?status": "active" })).toBe(true);
      expect(evaluatePredicateSync(pred, { "?status": "inactive" })).toBe(false);
    });

    it("should evaluate != correctly", () => {
      const pred: PredicateClause = ["!=", "?status", "active"];

      expect(evaluatePredicateSync(pred, { "?status": "inactive" })).toBe(true);
      expect(evaluatePredicateSync(pred, { "?status": "active" })).toBe(false);
    });

    it("should compare two variables", () => {
      const pred: PredicateClause = [">", "?x", "?y"];

      expect(evaluatePredicateSync(pred, { "?x": 10, "?y": 5 })).toBe(true);
      expect(evaluatePredicateSync(pred, { "?x": 5, "?y": 10 })).toBe(false);
    });

    it("should return false for unbound variables", () => {
      const pred: PredicateClause = [">", "?age", 25];

      expect(evaluatePredicateSync(pred, {})).toBe(false);
    });

    it("should return false for type mismatch in numeric ops", () => {
      const pred: PredicateClause = [">", "?x", "?y"];

      expect(evaluatePredicateSync(pred, { "?x": "hello", "?y": 5 })).toBe(false);
    });
  });

  describe("queryWhere", () => {
    it("should handle single pattern", () => {
      const clauses = [["?person", ":name", "?name"] as PatternClause];

      const results = queryWhere(clauses, sampleTriples);

      expect(results).toHaveLength(5);
    });

    it("should handle join through shared variable", () => {
      const clauses = [
        ["?person", ":name", "?name"],
        ["?person", ":age", "?age"],
      ] as PatternClause[];

      const results = queryWhere(clauses, sampleTriples);

      // Only p1, p2, p3 have both :name and :age
      expect(results).toHaveLength(3);
      expect(results).toContainEqual({ "?person": "p1", "?name": "Alice", "?age": 30 });
      expect(results).toContainEqual({ "?person": "p2", "?name": "Bob", "?age": 25 });
      expect(results).toContainEqual({ "?person": "p3", "?name": "Charlie", "?age": 35 });
    });

    it("should handle predicate filtering", () => {
      const clauses = [
        ["?person", ":name", "?name"],
        ["?person", ":age", "?age"],
        [">=", "?age", 30],
      ] as (PatternClause | PredicateClause)[];

      const results = queryWhere(clauses, sampleTriples);

      // Only Alice (30) and Charlie (35) are >= 30
      expect(results).toHaveLength(2);
      expect(results).toContainEqual({ "?person": "p1", "?name": "Alice", "?age": 30 });
      expect(results).toContainEqual({ "?person": "p3", "?name": "Charlie", "?age": 35 });
    });

    it("should handle complex join (movie director)", () => {
      const clauses = [
        ["?movie", ":title", "?title"],
        ["?movie", ":director", "?directorId"],
        ["?directorId", ":name", "?directorName"],
      ] as PatternClause[];

      const results = queryWhere(clauses, sampleTriples);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        "?movie": "m1",
        "?title": "The Terminator",
        "?directorId": "p4",
        "?directorName": "James Cameron",
      });
    });

    it("should return empty when no matches", () => {
      const clauses = [["?person", ":name", "Nobody"]] as PatternClause[];

      const results = queryWhere(clauses, sampleTriples);

      expect(results).toEqual([]);
    });

    it("should handle empty where clause", () => {
      const results = queryWhere([], sampleTriples);

      // Empty where means one empty context
      expect(results).toEqual([{}]);
    });
  });

  describe("actualize", () => {
    it("should extract find variables from context", () => {
      const context: Context = {
        "?person": "p1",
        "?name": "Alice",
        "?age": 30,
        "?extra": "ignored",
      };
      const find = ["?name", "?age"];

      const result = actualize(context, find);

      expect(result).toEqual({
        "?name": "Alice",
        "?age": 30,
      });
    });

    it("should handle constants in find", () => {
      const context: Context = { "?name": "Alice" };
      const find = ["?name", "constant"];

      const result = actualize(context, find);

      expect(result).toEqual({
        "?name": "Alice",
        constant: "constant",
      });
    });

    it("should skip unbound variables", () => {
      const context: Context = { "?name": "Alice" };
      const find = ["?name", "?unbound"];

      const result = actualize(context, find);

      expect(result).toEqual({ "?name": "Alice" });
    });
  });

  describe("querySync", () => {
    it("should execute a simple query", () => {
      const result = querySync(
        {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        sampleTriples,
      );

      expect(result).toHaveLength(5);
      expect(result).toContainEqual({ "?name": "Alice" });
      expect(result).toContainEqual({ "?name": "Bob" });
    });

    it("should execute query with filter", () => {
      const result = querySync(
        {
          find: ["?name", "?age"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":age", "?age"],
            [">=", "?age", 30],
          ],
        },
        sampleTriples,
      );

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ "?name": "Alice", "?age": 30 });
      expect(result).toContainEqual({ "?name": "Charlie", "?age": 35 });
    });

    it("should execute movie director query", () => {
      const result = querySync(
        {
          find: ["?title", "?directorName"],
          where: [
            ["?movie", ":title", "?title"],
            ["?movie", ":director", "?directorId"],
            ["?directorId", ":name", "?directorName"],
          ],
        },
        sampleTriples,
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        "?title": "The Terminator",
        "?directorName": "James Cameron",
      });
    });

    it("should remove duplicate results", () => {
      // Create triples that would produce duplicates
      const triples: SimplifiedTriple[] = [
        ["p1", ":tag", "a"],
        ["p1", ":tag", "b"],
        ["p1", ":name", "Alice"],
      ];

      const result = querySync(
        {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        triples,
      );

      // Should have one result, not duplicated
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ "?name": "Alice" });
    });

    it("should return empty for no matches", () => {
      const result = querySync(
        {
          find: ["?name"],
          where: [["?person", ":name", "Nobody"]],
        },
        sampleTriples,
      );

      expect(result).toEqual([]);
    });

    it("should handle equality predicate", () => {
      const result = querySync(
        {
          find: ["?name"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":status", "?status"],
            ["=", "?status", "active"],
          ],
        },
        sampleTriples,
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ "?name": "Alice" });
    });

    it("should handle inequality predicate", () => {
      const result = querySync(
        {
          find: ["?name"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":status", "?status"],
            ["!=", "?status", "active"],
          ],
        },
        sampleTriples,
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ "?name": "Bob" });
    });
  });
});
