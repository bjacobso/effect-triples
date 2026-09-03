import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import {
  Variable,
  DatalogAttribute,
  Constant,
  Term,
  PredicateOp,
  PatternClause,
  PredicateClause,
  OrClause,
  Clause,
  DatalogQuery,
  RuleApplication,
  Rule,
  isVariable,
  isAttribute,
  isPredicateClause,
  isPatternClause,
  normalizeOrAlternatives,
} from "../../src/datalog/schema.js";

describe("Datalog Schema", () => {
  describe("Variable", () => {
    it("should accept valid variables", () => {
      const decode = Schema.decodeUnknownSync(Variable);

      expect(decode("?x")).toBe("?x");
      expect(decode("?person")).toBe("?person");
      expect(decode("?movieId")).toBe("?movieId");
      expect(decode("?_private")).toBe("?_private");
      expect(decode("?name123")).toBe("?name123");
    });

    it("should reject invalid variables", () => {
      const decode = Schema.decodeUnknownSync(Variable);

      expect(() => decode("x")).toThrow();
      expect(() => decode("person")).toThrow();
      expect(() => decode("?")).toThrow();
      expect(() => decode("?123")).toThrow(); // can't start with number
      expect(() => decode("")).toThrow();
      expect(() => decode(123)).toThrow();
    });
  });

  describe("DatalogAttribute", () => {
    it("should accept valid attributes", () => {
      const decode = Schema.decodeUnknownSync(DatalogAttribute);

      expect(decode(":name")).toBe(":name");
      expect(decode(":age")).toBe(":age");
      expect(decode(":movie/title")).toBe(":movie/title");
      expect(decode(":person/first-name")).toBe(":person/first-name");
      expect(decode(":_internal")).toBe(":_internal");
    });

    it("should reject invalid attributes", () => {
      const decode = Schema.decodeUnknownSync(DatalogAttribute);

      expect(() => decode("name")).toThrow();
      expect(() => decode(":")).toThrow();
      expect(() => decode(":123")).toThrow(); // can't start with number
      expect(() => decode("")).toThrow();
      expect(() => decode(123)).toThrow();
    });
  });

  describe("Constant", () => {
    it("should accept strings, numbers, and booleans", () => {
      const decode = Schema.decodeUnknownSync(Constant);

      expect(decode("Alice")).toBe("Alice");
      expect(decode("")).toBe("");
      expect(decode(42)).toBe(42);
      expect(decode(3.14)).toBe(3.14);
      expect(decode(-10)).toBe(-10);
      expect(decode(true)).toBe(true);
      expect(decode(false)).toBe(false);
    });

    it("should reject invalid constants", () => {
      const decode = Schema.decodeUnknownSync(Constant);

      expect(() => decode(null)).toThrow();
      expect(() => decode(undefined)).toThrow();
      expect(() => decode({})).toThrow();
      expect(() => decode([])).toThrow();
      expect(() => decode("?reserved-for-variables")).toThrow();
    });
  });

  describe("Term", () => {
    it("should accept variables and constants", () => {
      const decode = Schema.decodeUnknownSync(Term);

      // Variables
      expect(decode("?x")).toBe("?x");
      expect(decode("?person")).toBe("?person");

      // Constants
      expect(decode("Alice")).toBe("Alice");
      expect(decode(42)).toBe(42);
      expect(decode(true)).toBe(true);

      expect(() => decode("?not-a-valid-variable")).toThrow();
    });
  });

  describe("PredicateOp", () => {
    it("should accept valid operators", () => {
      const decode = Schema.decodeUnknownSync(PredicateOp);

      expect(decode(">")).toBe(">");
      expect(decode(">=")).toBe(">=");
      expect(decode("<")).toBe("<");
      expect(decode("<=")).toBe("<=");
      expect(decode("=")).toBe("=");
      expect(decode("!=")).toBe("!=");
    });

    it("should reject invalid operators", () => {
      const decode = Schema.decodeUnknownSync(PredicateOp);

      expect(() => decode(">>")).toThrow();
      expect(() => decode("==")).toThrow();
      expect(() => decode("!")).toThrow();
      expect(() => decode("")).toThrow();
    });
  });

  describe("PatternClause", () => {
    it("should accept valid pattern clauses", () => {
      const decode = Schema.decodeUnknownSync(PatternClause);

      // All variables
      expect(decode(["?e", "?a", "?v"])).toEqual(["?e", "?a", "?v"]);

      // Mixed
      expect(decode(["?person", ":name", "Alice"])).toEqual(["?person", ":name", "Alice"]);
      expect(decode(["?person", ":age", 30])).toEqual(["?person", ":age", 30]);
      expect(decode(["?person", ":active", true])).toEqual(["?person", ":active", true]);

      // All constants (unusual but valid)
      expect(decode(["p1", ":name", "Alice"])).toEqual(["p1", ":name", "Alice"]);
    });

    it("should accept 4-tuple patterns with tx binding", () => {
      const decode = Schema.decodeUnknownSync(PatternClause);

      // 4-tuple with tx variable
      expect(decode(["?person", ":name", "?name", "?tx"])).toEqual([
        "?person",
        ":name",
        "?name",
        "?tx",
      ]);

      // 4-tuple with tx constant
      expect(decode(["?person", ":name", "?name", "tx-123"])).toEqual([
        "?person",
        ":name",
        "?name",
        "tx-123",
      ]);
    });

    it("should reject invalid pattern clauses", () => {
      const decode = Schema.decodeUnknownSync(PatternClause);

      expect(() => decode([])).toThrow();
      expect(() => decode(["?x"])).toThrow();
      expect(() => decode(["?x", "?y"])).toThrow();
      expect(() => decode(["?x", "?y", "?z", "?w", "?v"])).toThrow(); // too many elements (5)
      expect(() => decode("?x")).toThrow();
      expect(() => decode([42, ":name", "Alice"])).toThrow();
      expect(() => decode(["person:1", true, "Alice"])).toThrow();
      expect(() =>
        decode(["person:1", ":friend", { type: "ref", value: "person:2" }, 42]),
      ).toThrow();
      expect(() => decode([{ type: "ref", value: "person:1" }, ":name", "Alice"])).toThrow();
    });
  });

  describe("PredicateClause", () => {
    it("should accept valid predicate clauses", () => {
      const decode = Schema.decodeUnknownSync(PredicateClause);

      expect(decode([">", "?age", 18])).toEqual([">", "?age", 18]);
      expect(decode([">=", "?age", 21])).toEqual([">=", "?age", 21]);
      expect(decode(["<", "?count", 100])).toEqual(["<", "?count", 100]);
      expect(decode(["<=", "?x", "?y"])).toEqual(["<=", "?x", "?y"]);
      expect(decode(["=", "?status", "active"])).toEqual(["=", "?status", "active"]);
      expect(decode(["!=", "?x", "?y"])).toEqual(["!=", "?x", "?y"]);
    });

    it("should reject invalid predicate clauses", () => {
      const decode = Schema.decodeUnknownSync(PredicateClause);

      expect(() => decode([">>", "?x", 10])).toThrow(); // invalid operator
      expect(() => decode([">", "?x"])).toThrow(); // too few elements
      expect(() => decode([">", "?x", 10, 20])).toThrow(); // too many elements
    });
  });

  describe("Clause", () => {
    it("should accept both pattern and predicate clauses", () => {
      const decode = Schema.decodeUnknownSync(Clause);

      // Pattern
      expect(decode(["?person", ":name", "?name"])).toEqual(["?person", ":name", "?name"]);

      // Predicate
      expect(decode([">=", "?age", 18])).toEqual([">=", "?age", 18]);
    });
  });

  describe("OrClause", () => {
    it("accepts predicate and not alternatives", () => {
      const decode = Schema.decodeUnknownSync(OrClause);

      expect(
        decode([
          "or",
          [
            ["=", "?status", "offline"],
            ["not", ["?step", ":workflow-step/output-schema", "?os"]],
          ],
        ]),
      ).toEqual([
        "or",
        [
          ["=", "?status", "offline"],
          ["not", ["?step", ":workflow-step/output-schema", "?os"]],
        ],
      ]);
    });

    it("normalizes flat alternatives to canonical grouped alternatives", () => {
      expect(
        normalizeOrAlternatives([
          "or",
          ["?step", ":workflow-step/input-schema", "?is"],
          ["not", ["?step", ":workflow-step/output-schema", "?os"]],
        ] as unknown as ["or", ...Clause[]]),
      ).toEqual([
        ["?step", ":workflow-step/input-schema", "?is"],
        ["not", ["?step", ":workflow-step/output-schema", "?os"]],
      ]);
    });
  });

  describe("DatalogQuery", () => {
    it("should accept valid queries", () => {
      const decode = Schema.decodeUnknownSync(DatalogQuery);

      // Simple query
      expect(
        decode({
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        }),
      ).toEqual({
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
      });

      // Query with multiple patterns
      expect(
        decode({
          find: ["?name", "?age"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":age", "?age"],
          ],
        }),
      ).toEqual({
        find: ["?name", "?age"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
        ],
      });

      // Query with predicates
      expect(
        decode({
          find: ["?name", "?age"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":age", "?age"],
            [">=", "?age", 18],
          ],
        }),
      ).toEqual({
        find: ["?name", "?age"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
          [">=", "?age", 18],
        ],
      });

      // Empty where (returns all)
      expect(
        decode({
          find: ["?x"],
          where: [],
        }),
      ).toEqual({
        find: ["?x"],
        where: [],
      });
    });

    it("should reject invalid queries", () => {
      const decode = Schema.decodeUnknownSync(DatalogQuery);

      expect(() => decode({})).toThrow();
      expect(() => decode({ find: [] })).toThrow(); // missing where
      expect(() => decode({ where: [] })).toThrow(); // missing find
      expect(() => decode({ find: "?x", where: [] })).toThrow(); // find must be array
      expect(() => decode({ find: [], where: "x" })).toThrow(); // where must be array
    });
  });

  describe("Rule", () => {
    const decode = Schema.decodeUnknownSync(Rule);

    it("accepts quoted-SQL-safe names and positive recursion depths", () => {
      expect(
        decode({
          name: "ancestor-path",
          body: [["?child", ":parent", "?parent"]],
          maxDepth: 25,
        }),
      ).toEqual({
        name: "ancestor-path",
        body: [["?child", ":parent", "?parent"]],
        maxDepth: 25,
      });
    });

    it("rejects reserved or unsafe names and invalid recursion depths", () => {
      expect(() => decode({ name: "not", body: [["?x", ":parent", "?y"]] })).toThrow();
      expect(() =>
        decode({ name: `ancestor"; DROP TABLE triples`, body: [["?x", ":parent", "?y"]] }),
      ).toThrow();
      expect(() =>
        decode({ name: "ancestor", body: [["?x", ":parent", "?y"]], maxDepth: 0 }),
      ).toThrow();
      expect(() =>
        decode({ name: "ancestor", body: [["?x", ":parent", "?y"]], maxDepth: 1.5 }),
      ).toThrow();
    });
  });

  describe("RuleApplication", () => {
    const decode = Schema.decodeUnknownSync(RuleApplication);

    it("accepts string identities and variables", () => {
      expect(decode(["ancestor", "person:alice", "?ancestor"])).toEqual([
        "ancestor",
        "person:alice",
        "?ancestor",
      ]);
      expect(decode(["connected", "?left", "?right"])).toEqual(["connected", "?left", "?right"]);
    });

    it("rejects scalar values that cannot identify rule endpoints", () => {
      expect(() => decode(["ancestor", 42, "?ancestor"])).toThrow();
      expect(() => decode(["ancestor", "person:alice", false])).toThrow();
      expect(() =>
        decode(["ancestor", { type: "ref", value: "person:alice" }, "?ancestor"]),
      ).toThrow();
    });
  });

  describe("isVariable", () => {
    it("should correctly identify variables", () => {
      expect(isVariable("?x")).toBe(true);
      expect(isVariable("?person")).toBe(true);
      expect(isVariable("?_var")).toBe(true);

      expect(isVariable("x")).toBe(false);
      expect(isVariable(":name")).toBe(false);
      expect(isVariable("Alice")).toBe(false);
      expect(isVariable(42)).toBe(false);
      expect(isVariable(true)).toBe(false);
      expect(isVariable(null)).toBe(false);
    });
  });

  describe("isAttribute", () => {
    it("should correctly identify attributes", () => {
      expect(isAttribute(":name")).toBe(true);
      expect(isAttribute(":movie/title")).toBe(true);
      expect(isAttribute(":_attr")).toBe(true);

      expect(isAttribute("name")).toBe(false);
      expect(isAttribute("?x")).toBe(false);
      expect(isAttribute(42)).toBe(false);
    });
  });

  describe("isPredicateClause", () => {
    it("should correctly identify predicate clauses", () => {
      expect(isPredicateClause([">", "?x", 10])).toBe(true);
      expect(isPredicateClause([">=", "?x", 10])).toBe(true);
      expect(isPredicateClause(["<", "?x", 10])).toBe(true);
      expect(isPredicateClause(["<=", "?x", 10])).toBe(true);
      expect(isPredicateClause(["=", "?x", "y"])).toBe(true);
      expect(isPredicateClause(["!=", "?x", "?y"])).toBe(true);

      expect(isPredicateClause(["?e", ":a", "?v"])).toBe(false);
      expect(isPredicateClause(["p1", ":name", "Alice"])).toBe(false);
    });
  });

  describe("isPatternClause", () => {
    it("should correctly identify pattern clauses", () => {
      expect(isPatternClause(["?e", ":a", "?v"])).toBe(true);
      expect(isPatternClause(["?person", ":name", "Alice"])).toBe(true);
      expect(isPatternClause(["p1", ":name", "Alice"])).toBe(true);

      expect(isPatternClause([">", "?x", 10])).toBe(false);
      expect(isPatternClause([">=", "?age", 18])).toBe(false);
    });
  });
});
