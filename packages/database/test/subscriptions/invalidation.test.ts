import { describe, it, expect } from "vitest";
import { checkInvalidation, isAffectedByChange } from "../../src/subscriptions/invalidation.js";
import { extractDependencies } from "../../src/subscriptions/extract-dependencies.js";
import type { QueryDependencies, TripleChange } from "../../src/subscriptions/types.js";
import type { DatalogQuery } from "../../src/Datalog.js";

// Helper to create dependencies from a query
const depsFrom = (query: DatalogQuery) => extractDependencies(query);

// Helper to create a change
const change = (
  entityId: string,
  attribute: string,
  operation: "assert" | "retract" = "assert",
): TripleChange => ({ entityId, attribute, operation });

describe("checkInvalidation", () => {
  describe("empty inputs", () => {
    it("returns not affected when changes array is empty", () => {
      const deps = depsFrom({
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      });

      const result = checkInvalidation(deps, []);

      expect(result.affected).toBe(false);
      expect(result.matchingChanges).toHaveLength(0);
      expect(result.reason).toBe("No changes provided");
    });

    it("returns not affected when query has no dependencies", () => {
      const deps: QueryDependencies = {
        attributes: new Set(),
        entityTypes: new Set(),
        boundEntityIds: new Set(),
        linkTypes: new Set(),
        ruleNames: new Set(),
      };

      const result = checkInvalidation(deps, [change("emp:alice", ":employee/name")]);

      expect(result.affected).toBe(false);
      expect(result.reason).toBe("Query has no data dependencies");
    });
  });

  describe("entity-scoped queries (Level 3 filtering)", () => {
    it("should NOT invalidate when different entity changes", () => {
      // Query: viewing emp:alice
      const deps = depsFrom({
        find: ["?name"],
        where: [["emp:alice", ":employee/name", "?name"]],
      });

      // Change: emp:bob's name changed
      const result = checkInvalidation(deps, [change("emp:bob", ":employee/name")]);

      expect(result.affected).toBe(false);
      expect(result.matchingChanges).toHaveLength(0);
      expect(result.reason).toBe("No changes overlap with query dependencies");
    });

    it("should invalidate when same entity changes", () => {
      // Query: viewing emp:alice
      const deps = depsFrom({
        find: ["?name"],
        where: [["emp:alice", ":employee/name", "?name"]],
      });

      // Change: emp:alice's name changed
      const result = checkInvalidation(deps, [change("emp:alice", ":employee/name")]);

      expect(result.affected).toBe(true);
      expect(result.matchingChanges).toHaveLength(1);
      expect(result.matchingChanges[0]).toEqual(change("emp:alice", ":employee/name"));
    });

    it("should invalidate when any bound entity changes", () => {
      // Query: viewing multiple specific employees
      const deps = depsFrom({
        find: ["?name"],
        where: [
          ["emp:alice", ":employee/name", "?name"],
          ["emp:bob", ":employee/name", "?name"],
        ],
      });

      // Change: emp:bob's name changed
      const result = checkInvalidation(deps, [change("emp:bob", ":employee/name")]);

      expect(result.affected).toBe(true);
    });

    it("should NOT invalidate scoped query when unrelated entity changes", () => {
      // Query: viewing specific employees alice and bob
      const deps = depsFrom({
        find: ["?name"],
        where: [
          ["emp:alice", ":employee/name", "?name"],
          ["emp:bob", ":employee/name", "?name"],
        ],
      });

      // Change: emp:charlie's name changed (not in the query)
      const result = checkInvalidation(deps, [change("emp:charlie", ":employee/name")]);

      expect(result.affected).toBe(false);
    });
  });

  describe("entity-type-scoped queries (Level 1 filtering)", () => {
    it("should NOT invalidate when different entity type changes", () => {
      // Query: listing all employees
      const deps = depsFrom({
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      });

      // Change: a department changed
      const result = checkInvalidation(deps, [change("dept:eng", ":department/name")]);

      expect(result.affected).toBe(false);
    });

    it("should invalidate when same entity type changes", () => {
      // Query: listing all employees
      const deps = depsFrom({
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      });

      // Change: an employee changed
      const result = checkInvalidation(deps, [change("emp:bob", ":employee/name")]);

      expect(result.affected).toBe(true);
    });

    it("should invalidate when any joined entity type changes", () => {
      // Query: employees with department names
      const deps = depsFrom({
        find: ["?empName", "?deptName"],
        where: [
          ["?emp", ":employee/name", "?empName"],
          ["?emp", ":employee/department", "?dept"],
          ["?dept", ":department/name", "?deptName"],
        ],
      });

      // Change: a department name changed
      const result = checkInvalidation(deps, [change("dept:eng", ":department/name")]);

      expect(result.affected).toBe(true);
    });
  });

  describe("attribute-level filtering (Level 2)", () => {
    it("should NOT invalidate when different attribute changes", () => {
      // Query: only reads employee name
      const deps = depsFrom({
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      });

      // Change: employee salary changed (not read by query)
      const result = checkInvalidation(deps, [change("emp:alice", ":employee/salary")]);

      expect(result.affected).toBe(false);
    });

    it("should invalidate when same attribute changes", () => {
      // Query: reads employee name
      const deps = depsFrom({
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      });

      // Change: employee name changed
      const result = checkInvalidation(deps, [change("emp:alice", ":employee/name")]);

      expect(result.affected).toBe(true);
    });

    it("should invalidate when any read attribute changes", () => {
      // Query: reads name and email
      const deps = depsFrom({
        find: ["?name", "?email"],
        where: [
          ["?emp", ":employee/name", "?name"],
          ["?emp", ":employee/email", "?email"],
        ],
      });

      // Change: email changed (one of the read attributes)
      const result = checkInvalidation(deps, [change("emp:alice", ":employee/email")]);

      expect(result.affected).toBe(true);
    });
  });

  describe("batch changes", () => {
    it("should return all matching changes", () => {
      // Query: listing employees
      const deps = depsFrom({
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      });

      // Multiple changes
      const changes = [
        change("emp:alice", ":employee/name"),
        change("emp:bob", ":employee/salary"), // different attribute
        change("emp:charlie", ":employee/name"),
        change("dept:eng", ":department/name"), // different type
      ];

      const result = checkInvalidation(deps, changes);

      expect(result.affected).toBe(true);
      expect(result.matchingChanges).toHaveLength(2);
      expect(result.matchingChanges).toContainEqual(change("emp:alice", ":employee/name"));
      expect(result.matchingChanges).toContainEqual(change("emp:charlie", ":employee/name"));
    });

    it("should return not affected when no changes match", () => {
      // Query: reading employees
      const deps = depsFrom({
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      });

      // Only department changes
      const changes = [
        change("dept:eng", ":department/name"),
        change("dept:sales", ":department/budget"),
      ];

      const result = checkInvalidation(deps, changes);

      expect(result.affected).toBe(false);
      expect(result.matchingChanges).toHaveLength(0);
    });
  });

  describe("operation type", () => {
    it("treats assert and retract the same for invalidation", () => {
      const deps = depsFrom({
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      });

      const assertResult = checkInvalidation(deps, [
        change("emp:alice", ":employee/name", "assert"),
      ]);

      const retractResult = checkInvalidation(deps, [
        change("emp:alice", ":employee/name", "retract"),
      ]);

      expect(assertResult.affected).toBe(true);
      expect(retractResult.affected).toBe(true);
    });
  });

  describe("link queries", () => {
    it("should invalidate when _link attributes change", () => {
      // Query: finding who manages who
      const deps = depsFrom({
        find: ["?manager", "?employee"],
        where: [["link", "manages", "?manager", "?employee"]],
      });

      // Change: a link was created
      const result = checkInvalidation(deps, [change("link:123", ":_link/source")]);

      expect(result.affected).toBe(true);
    });
  });
});

describe("isAffectedByChange", () => {
  it("returns true for single matching change", () => {
    const deps = depsFrom({
      find: ["?name"],
      where: [["?emp", ":employee/name", "?name"]],
    });

    expect(isAffectedByChange(deps, change("emp:alice", ":employee/name"))).toBe(true);
  });

  it("returns false for non-matching change", () => {
    const deps = depsFrom({
      find: ["?name"],
      where: [["?emp", ":employee/name", "?name"]],
    });

    expect(isAffectedByChange(deps, change("dept:eng", ":department/name"))).toBe(false);
  });
});

describe("real-world scenarios", () => {
  describe("employee detail page", () => {
    const detailPageQuery: DatalogQuery = {
      find: ["?name", "?email", "?dept", "?deptName"],
      where: [
        ["emp:alice", ":employee/name", "?name"],
        ["emp:alice", ":employee/email", "?email"],
        ["emp:alice", ":employee/department", "?dept"],
        ["?dept", ":department/name", "?deptName"],
      ],
    };

    it("should refresh when Alice's name changes", () => {
      const deps = depsFrom(detailPageQuery);
      const result = checkInvalidation(deps, [change("emp:alice", ":employee/name")]);
      expect(result.affected).toBe(true);
    });

    it("should refresh when any department name changes", () => {
      const deps = depsFrom(detailPageQuery);
      // The query reads :department/name via a variable (?dept), not a bound entity.
      // Even though emp:alice is bound, departments are accessed via variable,
      // so ANY department name change could affect the query results.
      const result = checkInvalidation(deps, [change("dept:eng", ":department/name")]);
      expect(result.affected).toBe(true);
    });

    it("should NOT refresh when Bob's info changes", () => {
      const deps = depsFrom(detailPageQuery);
      const result = checkInvalidation(deps, [change("emp:bob", ":employee/name")]);
      expect(result.affected).toBe(false);
    });

    it("should NOT refresh when employee salary changes (not read)", () => {
      const deps = depsFrom(detailPageQuery);
      const result = checkInvalidation(deps, [change("emp:alice", ":employee/salary")]);
      expect(result.affected).toBe(false);
    });
  });

  describe("employee list page", () => {
    const listPageQuery: DatalogQuery = {
      find: ["?emp", "?name", "?dept"],
      where: [
        ["?emp", ":employee/name", "?name"],
        ["?emp", ":employee/department", "?dept"],
      ],
    };

    it("should refresh when any employee name changes", () => {
      const deps = depsFrom(listPageQuery);
      const result = checkInvalidation(deps, [change("emp:charlie", ":employee/name")]);
      expect(result.affected).toBe(true);
    });

    it("should refresh when any employee department changes", () => {
      const deps = depsFrom(listPageQuery);
      const result = checkInvalidation(deps, [change("emp:alice", ":employee/department")]);
      expect(result.affected).toBe(true);
    });

    it("should NOT refresh when department details change", () => {
      const deps = depsFrom(listPageQuery);
      // The list doesn't read :department/name, only :employee/department (which is a ref)
      const result = checkInvalidation(deps, [change("dept:eng", ":department/name")]);
      expect(result.affected).toBe(false);
    });
  });

  describe("dashboard with aggregation", () => {
    const dashboardQuery: DatalogQuery = {
      find: ["?dept", "?count"],
      where: [["?emp", ":employee/department", "?dept"]],
      aggregate: [["count", "?emp", "?count"]],
    };

    it("should refresh when employee department changes", () => {
      const deps = depsFrom(dashboardQuery);
      const result = checkInvalidation(deps, [change("emp:alice", ":employee/department")]);
      expect(result.affected).toBe(true);
    });

    it("should NOT refresh when employee name changes (not read)", () => {
      const deps = depsFrom(dashboardQuery);
      const result = checkInvalidation(deps, [change("emp:alice", ":employee/name")]);
      expect(result.affected).toBe(false);
    });
  });
});
