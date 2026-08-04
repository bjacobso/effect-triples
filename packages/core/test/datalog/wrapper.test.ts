import { describe, it, expect } from "vitest";
import { compileWrapped } from "../../src/datalog/wrapper.js";
import type { WrappedQuery } from "../../src/datalog/types.js";

describe("Datalog Wrapper Compiler", () => {
  describe("basic wrapping", () => {
    it("should wrap a simple query in a CTE", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
      };

      const result = compileWrapped(query);

      expect(result.sql).toContain("WITH inner_results AS (");
      expect(result.sql).toContain("SELECT DISTINCT");
      expect(result.sql).toContain("FROM inner_results");
      expect(result.sql).toContain('"?name"');
      expect(result.countSql).toBeNull();
    });

    it("should preserve inner query limit/offset", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name", "?age"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":age", "?age"],
          ],
          limit: 1000,
          offset: 100,
        },
      };

      const result = compileWrapped(query);

      // Inner query should have its own limit/offset
      expect(result.sql).toContain("LIMIT 1000");
      expect(result.sql).toContain("OFFSET 100");
    });
  });

  describe("wrapper pagination", () => {
    it("should apply wrapper limit", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        limit: 20,
      };

      const result = compileWrapped(query);

      // The wrapper pagination should appear after FROM inner_results
      const fromIndex = result.sql.indexOf("FROM inner_results");
      const wrapperPart = result.sql.substring(fromIndex);
      expect(wrapperPart).toContain("LIMIT 20");
    });

    it("should handle both inner and wrapper pagination", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
          limit: 1000, // Inner limit
        },
        limit: 20, // Wrapper limit
      };

      const result = compileWrapped(query);

      // Should have two LIMIT clauses - one in CTE, one in outer query
      const limitMatches = result.sql.match(/LIMIT/g);
      expect(limitMatches?.length).toBe(2);
    });
  });

  describe("wrapper filters", () => {
    it("should compile equality filter", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name", "?dept"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":department", "?dept"],
          ],
        },
        filters: [{ column: "?dept", op: "=", value: "Engineering" }],
      };

      const result = compileWrapped(query);

      expect(result.sql).toContain('WHERE "?dept" = ?');
      expect(result.params).toContain("Engineering");
    });

    it("should compile like filter", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        filters: [{ column: "?name", op: "like", value: "%Smith%" }],
      };

      const result = compileWrapped(query);

      expect(result.sql).toContain('"?name" LIKE ?');
      expect(result.params).toContain("%Smith%");
    });

    it("should compile ilike filter for SQLite", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        filters: [{ column: "?name", op: "ilike", value: "%smith%" }],
      };

      const result = compileWrapped(query);

      expect(result.sql).toContain('"?name" LIKE ? COLLATE NOCASE');
      expect(result.params).toContain("%smith%");
    });

    it("should compile comparison filters", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name", "?age"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":age", "?age"],
          ],
        },
        filters: [
          { column: "?age", op: ">=", value: 18 },
          { column: "?age", op: "<", value: 65 },
        ],
      };

      const result = compileWrapped(query);

      expect(result.sql).toContain('"?age" >= ?');
      expect(result.sql).toContain('"?age" < ?');
      expect(result.params).toContain(18);
      expect(result.params).toContain(65);
    });

    it("should compile is-null and is-not-null filters", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name", "?email"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":email", "?email"],
          ],
        },
        filters: [{ column: "?email", op: "is-not-null" }],
      };

      const result = compileWrapped(query);

      expect(result.sql).toContain('"?email" IS NOT NULL');
    });

    it("should combine multiple filters with AND", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name", "?dept"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":department", "?dept"],
          ],
        },
        filters: [
          { column: "?name", op: "ilike", value: "%smith%" },
          { column: "?dept", op: "=", value: "Engineering" },
        ],
      };

      const result = compileWrapped(query);

      expect(result.sql).toContain("WHERE");
      expect(result.sql).toContain("AND");
    });
  });

  describe("wrapper ordering", () => {
    it("should apply wrapper order by", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name", "?age"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":age", "?age"],
          ],
        },
        orderBy: [{ variable: "?name", direction: "asc" }],
      };

      const result = compileWrapped(query);

      expect(result.sql).toContain('ORDER BY "?name" ASC');
    });

    it("should handle multiple order by columns", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name", "?age", "?dept"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":age", "?age"],
            ["?person", ":department", "?dept"],
          ],
        },
        orderBy: [
          { variable: "?dept", direction: "asc" },
          { variable: "?age", direction: "desc" },
        ],
      };

      const result = compileWrapped(query);

      expect(result.sql).toContain('ORDER BY "?dept" ASC, "?age" DESC');
    });
  });

  describe("count query", () => {
    it("should generate count query when includeCount is true", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        includeCount: true,
      };

      const result = compileWrapped(query);

      expect(result.countSql).not.toBeNull();
      expect(result.countSql).toContain("SELECT COUNT(*) AS total");
      expect(result.countSql).toContain("FROM inner_results");
    });

    it("should apply filters to count query", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        filters: [{ column: "?name", op: "ilike", value: "%smith%" }],
        includeCount: true,
      };

      const result = compileWrapped(query);

      expect(result.countSql).not.toBeNull();
      expect(result.countSql).toContain('WHERE "?name" LIKE ? COLLATE NOCASE');
      expect(result.countParams).toContain("%smith%");
    });

    it("should not include pagination in count query", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        limit: 20,
        offset: 40,
        includeCount: true,
      };

      const result = compileWrapped(query);

      expect(result.countSql).not.toBeNull();
      // Count query should not have LIMIT or OFFSET
      const countSqlAfterCTE = result.countSql!.substring(result.countSql!.indexOf("SELECT COUNT"));
      expect(countSqlAfterCTE).not.toContain("LIMIT");
      expect(countSqlAfterCTE).not.toContain("OFFSET");
    });

    it("should not generate count query when includeCount is false", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        includeCount: false,
      };

      const result = compileWrapped(query);

      expect(result.countSql).toBeNull();
    });
  });

  describe("parameter handling", () => {
    it("should properly order parameters", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        filters: [{ column: "?name", op: "like", value: "%test%" }],
      };

      const result = compileWrapped(query);

      // Inner query params should come first, then filter params
      expect(result.params[0]).toBe(":name"); // From inner query
      expect(result.params).toContain("%test%"); // From filter
    });

    it("should have separate params for main and count queries", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        filters: [{ column: "?name", op: "=", value: "test" }],
        includeCount: true,
      };

      const result = compileWrapped(query);

      // Both should have the same params (since no LIMIT/OFFSET params)
      expect(result.params.length).toBe(result.countParams.length);
    });
  });

  describe("column mapping", () => {
    it("should preserve column map from inner query", () => {
      const query: WrappedQuery = {
        inner: {
          find: ["?name", "?age"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":age", "?age"],
          ],
        },
      };

      const result = compileWrapped(query);

      expect(result.columnMap.get("?name")).toBe("?name");
      expect(result.columnMap.get("?age")).toBe("?age");
    });
  });

  describe("cursor pagination", () => {
    it("should compile single-column cursor keyset clause", () => {
      const cursor = btoa(JSON.stringify({ "?name": "Smith" }));
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        orderBy: [{ variable: "?name", direction: "asc" }],
        cursor,
        limit: 20,
      };

      const result = compileWrapped(query);

      // Should have keyset WHERE clause with > for ascending
      expect(result.sql).toContain('WHERE "?name" > ?');
      expect(result.params).toContain("Smith");
    });

    it("should compile single-column cursor with descending order", () => {
      const cursor = btoa(JSON.stringify({ "?age": 30 }));
      const query: WrappedQuery = {
        inner: {
          find: ["?age"],
          where: [["?person", ":age", "?age"]],
        },
        orderBy: [{ variable: "?age", direction: "desc" }],
        cursor,
        limit: 20,
      };

      const result = compileWrapped(query);

      // Should have keyset WHERE clause with < for descending
      expect(result.sql).toContain('WHERE "?age" < ?');
      expect(result.params).toContain(30);
    });

    it("should compile multi-column cursor keyset clause", () => {
      const cursor = btoa(JSON.stringify({ "?dept": "Engineering", "?age": 30 }));
      const query: WrappedQuery = {
        inner: {
          find: ["?name", "?dept", "?age"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":department", "?dept"],
            ["?person", ":age", "?age"],
          ],
        },
        orderBy: [
          { variable: "?dept", direction: "asc" },
          { variable: "?age", direction: "desc" },
        ],
        cursor,
        limit: 20,
      };

      const result = compileWrapped(query);

      // Should have compound OR condition for multi-column keyset
      // ("?dept" > ?) OR ("?dept" = ? AND "?age" < ?)
      expect(result.sql).toContain("WHERE");
      expect(result.sql).toMatch(/"[?]dept" > [?]/);
      expect(result.sql).toMatch(/OR/);
      expect(result.sql).toMatch(/"[?]dept" = [?] AND "[?]age" < [?]/);
      expect(result.params).toContain("Engineering");
      expect(result.params).toContain(30);
    });

    it("should combine cursor with filters", () => {
      const cursor = btoa(JSON.stringify({ "?name": "Smith" }));
      const query: WrappedQuery = {
        inner: {
          find: ["?name", "?dept"],
          where: [
            ["?person", ":name", "?name"],
            ["?person", ":department", "?dept"],
          ],
        },
        orderBy: [{ variable: "?name", direction: "asc" }],
        filters: [{ column: "?dept", op: "=", value: "Engineering" }],
        cursor,
        limit: 20,
      };

      const result = compileWrapped(query);

      // Should have both filter and cursor conditions combined with AND
      expect(result.sql).toContain('WHERE "?dept" = ?');
      expect(result.sql).toContain('AND "?name" > ?');
      expect(result.params).toContain("Engineering");
      expect(result.params).toContain("Smith");
    });

    it("should not include cursor in count query", () => {
      const cursor = btoa(JSON.stringify({ "?name": "Smith" }));
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        orderBy: [{ variable: "?name", direction: "asc" }],
        cursor,
        limit: 20,
        includeCount: true,
      };

      const result = compileWrapped(query);

      // Count query should not have cursor keyset condition
      // (we want total count of all matching rows, not count from cursor)
      expect(result.countSql).not.toBeNull();
      const countSqlAfterCTE = result.countSql!.substring(result.countSql!.indexOf("SELECT COUNT"));
      expect(countSqlAfterCTE).not.toContain('"?name" > ?');
    });

    it("should require orderBy for cursor pagination", () => {
      const cursor = btoa(JSON.stringify({ "?name": "Smith" }));
      const query: WrappedQuery = {
        inner: {
          find: ["?name"],
          where: [["?person", ":name", "?name"]],
        },
        // No orderBy - cursor should be ignored
        cursor,
        limit: 20,
      };

      const result = compileWrapped(query);

      // Without orderBy, cursor is ignored (no WHERE clause for keyset)
      expect(result.sql).not.toContain('"?name" > ?');
    });
  });
});
