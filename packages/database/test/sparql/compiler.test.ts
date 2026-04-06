import { describe, it, expect } from "vitest";
import { compile, compileToSql } from "../../src/sparql/compiler.js";
import type { SparqlQuery } from "../../src/sparql/types.js";

describe("SPARQL SQL Compiler", () => {
  describe("basic SELECT compilation", () => {
    it("should compile a simple SELECT query", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [["?person", ":name", "?name"]],
      };

      const result = compile(query);

      expect(result.sql).toContain("SELECT");
      expect(result.sql).not.toContain("SELECT DISTINCT"); // Regular SELECT, not DISTINCT
      expect(result.sql).toContain("FROM triples t0");
      expect(result.sql).toContain(`t0.attribute = ?`);
      expect(result.sql).toContain(`AS "?name"`);
      expect(result.columnMap.get("?name")).toBe("?name");
      expect(result.params).toContain(":name");
    });

    it("should compile SELECT DISTINCT query", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"], distinct: true },
        where: [["?person", ":name", "?name"]],
      };

      const result = compile(query);
      expect(result.sql).toContain("SELECT DISTINCT");
    });

    it("should compile query with constant string filter", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?person"] },
        where: [["?person", ":name", "Alice"]],
      };

      const result = compile(query);

      expect(result.sql).toContain(`t0.attribute = ?`);
      expect(result.sql).toContain(`t0.value_string = ?`);
      expect(result.sql).toContain(`t0.value_type = ?`);
      expect(result.params).toContain(":name");
      expect(result.params).toContain("Alice");
      expect(result.params).toContain("string");
    });

    it("should compile query with numeric constant", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?person"] },
        where: [["?person", ":age", 30]],
      };

      const result = compile(query);

      expect(result.sql).toContain(`t0.value_number = ?`);
      expect(result.sql).toContain(`t0.value_type = ?`);
      expect(result.params).toContain(30);
      expect(result.params).toContain("number");
    });

    it("should compile query with boolean constant", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?person"] },
        where: [["?person", ":active", true]],
      };

      const result = compile(query);

      expect(result.sql).toContain(`t0.value_boolean = ?`);
      expect(result.sql).toContain(`t0.value_type = ?`);
      expect(result.params).toContain(1); // booleans stored as 0/1
      expect(result.params).toContain("boolean");
    });
  });

  describe("JOIN compilation", () => {
    it("should create JOIN for multiple patterns with shared variable", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?age"] },
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("FROM triples t0");
      expect(sql).toContain("JOIN triples t1");
      expect(sql).toContain("t1.entity_id = t0.entity_id");
    });

    it("should create ref join (entity to value)", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?title", "?directorName"] },
        where: [
          ["?movie", ":title", "?title"],
          ["?movie", ":director", "?directorId"],
          ["?directorId", ":name", "?directorName"],
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("FROM triples t0");
      expect(sql).toContain("JOIN triples t1");
      expect(sql).toContain("JOIN triples t2");
      // Third pattern should join on the ref value
      expect(sql).toContain("t2.entity_id = t1.value_string");
    });
  });

  describe("OPTIONAL pattern compilation", () => {
    it("should create LEFT JOIN for OPTIONAL pattern", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?email"] },
        where: [["?person", ":name", "?name"], { optional: [["?person", ":email", "?email"]] }],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("FROM triples t0");
      expect(sql).toContain("LEFT JOIN triples t1");
      expect(sql).toContain("t1.entity_id = t0.entity_id");
    });

    it("should handle multiple OPTIONAL patterns", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?email", "?phone"] },
        where: [
          ["?person", ":name", "?name"],
          { optional: [["?person", ":email", "?email"]] },
          { optional: [["?person", ":phone", "?phone"]] },
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("LEFT JOIN triples t1");
      expect(sql).toContain("LEFT JOIN triples t2");
    });
  });

  describe("FILTER compilation", () => {
    it("should compile comparison filter (>=)", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?age"] },
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
          { filter: { op: ">=", left: "?age", right: 30 } },
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("WHERE");
      expect(sql).toContain(">= ?");
    });

    it("should compile comparison filter (!=)", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [
          ["?person", ":name", "?name"],
          { filter: { op: "!=", left: "?name", right: "Bob" } },
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("<>"); // SQL uses <> for !=
    });

    it("should compile built-in function filter (contains)", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [
          ["?person", ":name", "?name"],
          { filter: { fn: "contains", args: ["?name", "Ali"] } },
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("LIKE");
      expect(sql).toContain("%");
    });

    it("should compile regex filter", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [["?person", ":name", "?name"], { filter: { fn: "regex", args: ["?name", "^A"] } }],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("REGEXP");
    });

    it("should compile bound filter", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?email"] },
        where: [
          ["?person", ":name", "?name"],
          { optional: [["?person", ":email", "?email"]] },
          { filter: { fn: "bound", args: ["?email"] } },
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("IS NOT NULL");
    });

    it("should compile notBound filter", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [
          ["?person", ":name", "?name"],
          { optional: [["?person", ":email", "?email"]] },
          { filter: { fn: "notBound", args: ["?email"] } },
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("IS NULL");
    });

    it("should compile IN filter", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [
          ["?person", ":name", "?name"],
          { filter: { fn: "in", args: ["?name", "Alice", "Bob", "Charlie"] } },
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("IN (");
      expect(result.params).toContain("Alice");
      expect(result.params).toContain("Bob");
      expect(result.params).toContain("Charlie");
    });

    it("should compile NOT IN filter", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [
          ["?person", ":name", "?name"],
          { filter: { fn: "notIn", args: ["?name", "Alice", "Bob"] } },
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("NOT IN (");
    });

    it("should compile regex with case-insensitive flag", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [
          ["?person", ":name", "?name"],
          { filter: { fn: "regex", args: ["?name", "^alice", "i"] } },
        ],
      };

      const sql = compileToSql(query);

      // SQLite handles case-insensitive with LOWER()
      expect(sql).toContain("LOWER(");
      expect(sql).toContain("REGEXP");
    });
  });

  describe("BIND pattern compilation", () => {
    it("should compile BIND with constant", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?type"] },
        where: [["?person", ":name", "?name"], { bind: { expr: "Person", as: "?type" } }],
      };

      const result = compile(query);

      expect(result.sql).toContain(`AS "?type"`);
    });

    it("should compile BIND with math expression", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?doubleAge"] },
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
          { bind: { expr: { op: "*", left: "?age", right: 2 }, as: "?doubleAge" } },
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("*");
      expect(sql).toContain(`AS "?doubleAge"`);
    });
  });

  describe("ORDER BY compilation", () => {
    it("should compile ORDER BY ascending", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?age"] },
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
        ],
        orderBy: [{ variable: "?age", direction: "asc" }],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("ASC");
    });

    it("should compile ORDER BY descending", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?age"] },
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
        ],
        orderBy: [{ variable: "?age", direction: "desc" }],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("DESC");
    });

    it("should compile multiple ORDER BY clauses", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?age"] },
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
        ],
        orderBy: [
          { variable: "?age", direction: "desc" },
          { variable: "?name", direction: "asc" },
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("ORDER BY");
      expect(sql).toMatch(/DESC.*ASC/);
    });
  });

  describe("LIMIT and OFFSET compilation", () => {
    it("should compile LIMIT", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [["?person", ":name", "?name"]],
        limit: 10,
      };

      const result = compile(query);

      expect(result.sql).toContain("LIMIT ?"); // parameterized
      expect(result.params).toContain(10);
    });

    it("should compile OFFSET", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [["?person", ":name", "?name"]],
        offset: 5,
      };

      const result = compile(query);

      expect(result.sql).toContain("OFFSET ?"); // parameterized
      expect(result.params).toContain(5);
    });

    it("should compile LIMIT and OFFSET together", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name"] },
        where: [["?person", ":name", "?name"]],
        limit: 10,
        offset: 20,
      };

      const result = compile(query);

      expect(result.sql).toContain("LIMIT ?");
      expect(result.sql).toContain("OFFSET ?");
      expect(result.params).toContain(10);
      expect(result.params).toContain(20);
    });
  });

  describe("ASK query compilation", () => {
    it("should compile ASK query with EXISTS", () => {
      const query: SparqlQuery = {
        form: "ask",
        where: [["?person", ":name", "Alice"]],
      };

      const result = compile(query);

      expect(result.form).toBe("ask");
      expect(result.sql).toContain("SELECT");
      expect(result.sql).toContain("EXISTS");
    });
  });

  describe("aggregation compilation", () => {
    it("should compile COUNT aggregation", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?count"] },
        where: [["?person", ":name", "?name"]],
        aggregate: [["count", "?person", "?count"]],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("COUNT(");
      expect(sql).toContain(`AS "?count"`);
    });

    it("should compile SUM aggregation with GROUP BY", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?dept", "?totalSalary"] },
        where: [
          ["?emp", ":department", "?dept"],
          ["?emp", ":salary", "?salary"],
        ],
        aggregate: [["sum", "?salary", "?totalSalary"]],
        groupBy: ["?dept"],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("SUM(");
      expect(sql).toContain("GROUP BY");
    });

    it("should compile AVG aggregation", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?avgAge"] },
        where: [["?person", ":age", "?age"]],
        aggregate: [["avg", "?age", "?avgAge"]],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("AVG(");
    });
  });

  describe("metrics tracking", () => {
    it("should track compilation metrics", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?name", "?email"] },
        where: [
          ["?person", ":name", "?name"],
          { optional: [["?person", ":email", "?email"]] },
          { filter: { op: "!=", left: "?name", right: "Bob" } },
        ],
      };

      const result = compile(query, undefined, true);

      expect(result.metrics).toBeDefined();
      expect(result.metrics!.triplePatternCount).toBe(2);
      expect(result.metrics!.optionalCount).toBe(1);
      expect(result.metrics!.leftJoinCount).toBe(1);
      expect(result.metrics!.filterCount).toBe(1);
    });
  });

  describe("UNION pattern compilation", () => {
    it("should compile simple UNION pattern as first element", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?x"] },
        where: [
          {
            union: [[["?x", ":type", "Person"]], [["?x", ":type", "Company"]]],
          },
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("UNION ALL");
      expect(result.sql).toContain(`AS "?x"`);
      expect(result.params).toContain(":type");
      expect(result.params).toContain("Person");
      expect(result.params).toContain("Company");
    });

    it("should compile UNION after triple pattern", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?person", "?contact"] },
        where: [
          ["?person", ":name", "?name"],
          {
            union: [[["?person", ":email", "?contact"]], [["?person", ":phone", "?contact"]]],
          },
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("FROM triples t0");
      expect(result.sql).toContain("JOIN");
      expect(result.sql).toContain("UNION ALL");
      expect(result.sql).toContain(`AS "?contact"`);
    });

    it("should handle UNION with multiple variables", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?x", "?label"] },
        where: [
          {
            union: [
              [
                ["?x", ":type", "Person"],
                ["?x", ":personLabel", "?label"],
              ],
              [
                ["?x", ":type", "Company"],
                ["?x", ":companyLabel", "?label"],
              ],
            ],
          },
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("UNION ALL");
      expect(result.sql).toContain(`AS "?x"`);
      expect(result.sql).toContain(`AS "?label"`);
    });

    it("should track UNION metrics", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?x"] },
        where: [
          {
            union: [[["?x", ":type", "A"]], [["?x", ":type", "B"]]],
          },
        ],
      };

      const result = compile(query, undefined, true);

      expect(result.metrics).toBeDefined();
      expect(result.metrics!.unionCount).toBe(1);
      expect(result.metrics!.subqueryCount).toBe(1);
    });

    it("should compile UNION with FILTER", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?x", "?value"] },
        where: [
          {
            union: [[["?x", ":amount", "?value"]], [["?x", ":count", "?value"]]],
          },
          { filter: { op: ">", left: "?value", right: 100 } },
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("UNION ALL");
      expect(result.sql).toContain(">");
    });

    it("should handle UNION with different variables in branches (NULL filling)", () => {
      const query: SparqlQuery = {
        form: "select",
        select: { variables: ["?x", "?email", "?phone"] },
        where: [
          {
            union: [
              [
                ["?x", ":type", "Person"],
                ["?x", ":email", "?email"],
              ],
              [
                ["?x", ":type", "Company"],
                ["?x", ":phone", "?phone"],
              ],
            ],
          },
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("UNION ALL");
      // Both branches should have all three variables
      expect(result.sql).toContain(`AS "?x"`);
      expect(result.sql).toContain(`AS "?email"`);
      expect(result.sql).toContain(`AS "?phone"`);
      // One branch should have NULL for email, the other for phone
      expect(result.sql).toContain("NULL");
    });
  });
});
