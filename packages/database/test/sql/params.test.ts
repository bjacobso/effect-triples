/**
 * ParamCollector unit tests
 */

import { describe, it, expect } from "vitest";
import { createParamCollector } from "../../src/params.js";
import { SqliteDialect } from "../../src/dialects/sqlite.js";
import { PostgresqlDialect } from "../../src/dialects/postgresql.js";

describe("ParamCollector", () => {
  describe("with SQLite dialect", () => {
    it("should return ? placeholders", () => {
      const collector = createParamCollector(SqliteDialect);

      expect(collector.add("Alice")).toBe("?");
      expect(collector.add("Bob")).toBe("?");
      expect(collector.add(42)).toBe("?");
    });

    it("should collect params in order", () => {
      const collector = createParamCollector(SqliteDialect);

      collector.add("Alice");
      collector.add("Bob");
      collector.add(42);

      expect(collector.params).toEqual(["Alice", "Bob", 42]);
    });

    it("should convert booleans to integers", () => {
      const collector = createParamCollector(SqliteDialect);

      collector.add(true);
      collector.add(false);

      expect(collector.params).toEqual([1, 0]);
    });

    it("should return a copy of params from result()", () => {
      const collector = createParamCollector(SqliteDialect);
      collector.add("test");

      const result = collector.result();

      // Should be a copy, not the same reference
      expect(result.params).toEqual(["test"]);
      expect(result.params).not.toBe(collector.params);
    });
  });

  describe("with PostgreSQL dialect", () => {
    it("should return $N placeholders (1-indexed)", () => {
      const collector = createParamCollector(PostgresqlDialect);

      expect(collector.add("Alice")).toBe("$1");
      expect(collector.add("Bob")).toBe("$2");
      expect(collector.add(42)).toBe("$3");
    });

    it("should collect params in order", () => {
      const collector = createParamCollector(PostgresqlDialect);

      collector.add("first");
      collector.add("second");
      collector.add("third");

      expect(collector.params).toEqual(["first", "second", "third"]);
    });

    it("should convert booleans to integers", () => {
      const collector = createParamCollector(PostgresqlDialect);

      collector.add(true);
      collector.add(false);

      // Even PostgreSQL uses 1/0 for consistency in our triple store
      expect(collector.params).toEqual([1, 0]);
    });
  });

  describe("type handling", () => {
    it("should handle strings", () => {
      const collector = createParamCollector(SqliteDialect);
      collector.add("hello");
      expect(collector.params).toEqual(["hello"]);
    });

    it("should handle numbers", () => {
      const collector = createParamCollector(SqliteDialect);
      collector.add(42);
      collector.add(3.14);
      expect(collector.params).toEqual([42, 3.14]);
    });

    it("should handle null", () => {
      const collector = createParamCollector(SqliteDialect);
      collector.add(null);
      expect(collector.params).toEqual([null]);
    });

    it("should handle undefined", () => {
      const collector = createParamCollector(SqliteDialect);
      collector.add(undefined);
      expect(collector.params).toEqual([undefined]);
    });

    it("should preserve special string characters", () => {
      const collector = createParamCollector(SqliteDialect);

      collector.add("O'Brien");
      collector.add("'; DROP TABLE users; --");
      collector.add("100%");

      expect(collector.params).toEqual(["O'Brien", "'; DROP TABLE users; --", "100%"]);
    });
  });

  describe("integration patterns", () => {
    it("should work for building parameterized SQL", () => {
      const collector = createParamCollector(SqliteDialect);

      const sql = `SELECT * FROM users WHERE name = ${collector.add("Alice")} AND age > ${collector.add(18)}`;

      expect(sql).toBe("SELECT * FROM users WHERE name = ? AND age > ?");
      expect(collector.params).toEqual(["Alice", 18]);
    });

    it("should work for building PostgreSQL parameterized SQL", () => {
      const collector = createParamCollector(PostgresqlDialect);

      const sql = `SELECT * FROM users WHERE name = ${collector.add("Alice")} AND age > ${collector.add(18)}`;

      expect(sql).toBe("SELECT * FROM users WHERE name = $1 AND age > $2");
      expect(collector.params).toEqual(["Alice", 18]);
    });

    it("should expose the dialect for additional formatting", () => {
      const collector = createParamCollector(SqliteDialect);
      expect(collector.dialect.name).toBe("sqlite");

      const pgCollector = createParamCollector(PostgresqlDialect);
      expect(pgCollector.dialect.name).toBe("postgresql");
    });
  });
});
