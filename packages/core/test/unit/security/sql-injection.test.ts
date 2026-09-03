/**
 * SQL Injection Prevention Tests
 *
 * These tests verify that the parameterized query implementation
 * correctly prevents SQL injection attacks.
 */

import { describe, it, expect } from "vitest";
import { compile, compileWithRules } from "../../../src/datalog/compiler.js";
import type { DatalogQuery } from "../../../src/index.js";

describe("SQL Injection Prevention", () => {
  describe("Datalog Compiler", () => {
    it("should use parameterized queries for string values with SQL injection attempts", () => {
      const injectionPayloads = [
        "'; DROP TABLE triples; --",
        "1' OR '1'='1",
        "Robert'); DROP TABLE students;--",
        "1; DELETE FROM triples WHERE 1=1; --",
        "' UNION SELECT * FROM triples --",
      ];

      for (const payload of injectionPayloads) {
        const query: DatalogQuery = {
          find: ["?person"],
          where: [["?person", ":name", payload]],
        };

        const result = compile(query);

        // The payload should NOT appear in the SQL string
        expect(result.sql).not.toContain(payload);

        // The SQL should contain placeholders
        expect(result.sql).toContain("COALESCE(t0.value_string, t0.value_json) = ?");

        // The payload should be safely passed as a parameter
        expect(result.params).toContain(payload);
      }
    });

    it("should use parameterized queries for attribute values with special characters", () => {
      const query: DatalogQuery = {
        find: ["?person"],
        where: [["?person", ":name'; DROP TABLE triples; --", "?value"]],
      };

      const result = compile(query);

      // The injection attempt should be in params, not in SQL
      expect(result.sql).not.toContain("DROP TABLE");
      expect(result.sql).toContain("attribute = ?");
      expect(result.params).toContain(":name'; DROP TABLE triples; --");
    });

    it("should handle single quotes safely", () => {
      const query: DatalogQuery = {
        find: ["?person"],
        where: [["?person", ":name", "O'Brien"]],
      };

      const result = compile(query);

      // The value should not appear escaped in SQL
      expect(result.sql).not.toContain("O''Brien");
      expect(result.sql).not.toContain("O'Brien");

      // Should be passed as a parameter
      expect(result.params).toContain("O'Brien");
    });

    it("should handle backslashes safely", () => {
      const query: DatalogQuery = {
        find: ["?person"],
        where: [["?person", ":path", "C:\\Windows\\System32"]],
      };

      const result = compile(query);

      // Should be passed as a parameter, not embedded in SQL
      expect(result.sql).toContain("COALESCE(t0.value_string, t0.value_json) = ?");
      expect(result.params).toContain("C:\\Windows\\System32");
    });

    it("should use parameters in predicates", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":status", "?status"],
          ["=", "?status", "'; DROP TABLE triples; --"],
        ],
      };

      const result = compile(query);

      // Injection attempt should be in params
      expect(result.sql).not.toContain("DROP TABLE");
      expect(result.params).toContain("'; DROP TABLE triples; --");
    });

    it("should use parameters in NOT clauses", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["not", ["?person", ":status", "'; DELETE FROM triples; --"]],
        ],
      };

      const result = compile(query);

      // Injection attempt should be in params
      expect(result.sql).not.toContain("DELETE FROM");
      expect(result.params).toContain("'; DELETE FROM triples; --");
    });

    it("should use parameters in OR clauses", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          [
            "or",
            [
              ["?person", ":name", "Alice"],
              ["?person", ":name", "'; DROP TABLE triples; --"],
            ],
          ],
        ],
      };

      const result = compile(query);

      // Injection attempt should be in params
      expect(result.sql).not.toContain("DROP TABLE");
      expect(result.params).toContain("'; DROP TABLE triples; --");
    });

    it("should use parameters in HAVING clauses", () => {
      const query: DatalogQuery = {
        find: ["?dept", "?count"],
        where: [["?person", ":department", "?dept"]],
        aggregate: [["count", "?person", "?count"]],
        having: [[">=", "?count", 5]],
      };

      const result = compile(query);

      // Numeric value should be in params
      expect(result.sql).toContain(">= ?");
      expect(result.params).toContain(5);
    });

    it("should never interpolate find constants as SQL aliases", () => {
      const payload = `value" FROM triples; DROP TABLE triples; --`;
      const query: DatalogQuery = {
        find: [payload],
        where: [["?person", ":name", "Alice"]],
      };

      const result = compile(query);

      expect(result.sql).not.toContain(payload);
      expect(result.sql).toContain("AS _constant_0");
      expect(result.params).toContain(payload);
      expect(result.columnMap.get("_constant_0")).toBe(payload);
    });
  });

  describe("Query with Rules", () => {
    it("should use parameters for constant arguments in rule applications", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "'; DROP TABLE triples; --", "?ancestor"]],
        rules: [{ name: "ancestor", body: [["?x", ":parent", "?y"]] }],
      };

      const result = compileWithRules(query);

      // Injection attempt should be in params
      expect(result.sql).not.toContain("DROP TABLE");
      expect(result.params).toContain("'; DROP TABLE triples; --");
    });

    it("should parameterize constants inside rule definitions", () => {
      const payload = `:parent'; DROP TABLE triples; --`;
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "person:alice", "?ancestor"]],
        rules: [{ name: "ancestor", body: [["?x", payload, "?y"]] }],
      };

      const result = compileWithRules(query);

      expect(result.sql).not.toContain("DROP TABLE");
      expect(result.params).toContain(payload);
    });

    it("should reject invalid runtime rule identifiers", () => {
      const query = {
        find: ["?ancestor"],
        where: [[`ancestor"; DROP TABLE triples; --`, "person:alice", "?ancestor"]],
        rules: [
          {
            name: `ancestor"; DROP TABLE triples; --`,
            body: [["?x", ":parent", "?y"]],
          },
        ],
      } as unknown as DatalogQuery;

      expect(() => compileWithRules(query)).toThrow("Invalid Datalog query shape");
    });
  });

  describe("Params array is populated correctly", () => {
    it("should have params for all constant values in simple queries", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":status", "active"],
        ],
      };

      const result = compile(query);

      // Should have params for both attributes and the constant value
      expect(result.params).toContain(":name");
      expect(result.params).toContain(":status");
      expect(result.params).toContain("active");
    });

    it("should have params for all constant values in complex queries", () => {
      const query: DatalogQuery = {
        find: ["?name", "?dept"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":department", "?dept"],
          ["?person", ":status", "?status"],
          ["=", "?status", "active"],
          ["not", ["?person", ":banned", true]],
        ],
      };

      const result = compile(query);

      // Check key params are present
      expect(result.params).toContain(":name");
      expect(result.params).toContain(":department");
      expect(result.params).toContain(":status");
      expect(result.params).toContain("active");
      expect(result.params).toContain(":banned");
      expect(result.params).toContain(1); // true -> 1
    });

    it("should have params for constant values in rule queries", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "person1", "?ancestor"]],
        rules: [{ name: "ancestor", body: [["?x", ":parent", "?y"]] }],
      };

      const result = compileWithRules(query);

      // The constant argument should be in params
      expect(result.params).toContain("person1");
    });
  });
});
