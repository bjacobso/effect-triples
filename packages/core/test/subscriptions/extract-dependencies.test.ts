import { describe, it, expect } from "vitest";
import {
  extractDependencies,
  extractEntityType,
} from "../../src/subscriptions/extract-dependencies.js";
import type { DatalogQuery } from "../../src/Datalog.js";

describe("extractEntityType", () => {
  it("extracts entity type from standard attribute", () => {
    expect(extractEntityType(":employee/name")).toBe("employee");
    expect(extractEntityType(":department/budget")).toBe("department");
    expect(extractEntityType(":_link/type")).toBe("_link");
  });

  it("returns null for invalid attributes", () => {
    expect(extractEntityType("invalid")).toBeNull();
    expect(extractEntityType("employee/name")).toBeNull(); // missing colon
    expect(extractEntityType(":noSlash")).toBeNull();
  });

  it("handles complex attribute names", () => {
    expect(extractEntityType(":my-entity/some-attr")).toBe("my-entity");
    expect(extractEntityType(":Entity123/field_name")).toBe("Entity123");
  });
});

describe("extractDependencies", () => {
  describe("simple pattern clauses", () => {
    it("extracts attribute and entity type from single pattern", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      const deps = extractDependencies(query);

      expect(deps.attributes).toEqual(new Set([":employee/name"]));
      expect(deps.entityTypes).toEqual(new Set(["employee"]));
      expect(deps.boundEntityIds.size).toBe(0);
      expect(deps.boundEntityTypes.size).toBe(0);
      expect(deps.hasDynamicAttributes).toBe(false);
      expect(deps.linkTypes.size).toBe(0);
      expect(deps.ruleNames.size).toBe(0);
    });

    it("extracts multiple attributes from multiple patterns", () => {
      const query: DatalogQuery = {
        find: ["?name", "?email"],
        where: [
          ["?emp", ":employee/name", "?name"],
          ["?emp", ":employee/email", "?email"],
        ],
      };

      const deps = extractDependencies(query);

      expect(deps.attributes).toEqual(new Set([":employee/name", ":employee/email"]));
      expect(deps.entityTypes).toEqual(new Set(["employee"]));
    });

    it("extracts bound entity ID and type when entity is constant", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["emp:alice", ":employee/name", "?name"]],
      };

      const deps = extractDependencies(query);

      expect(deps.boundEntityIds).toEqual(new Set(["emp:alice"]));
      expect(deps.boundEntityTypes).toEqual(new Set(["employee"]));
      expect(deps.attributes).toEqual(new Set([":employee/name"]));
    });

    it("extracts multiple bound entity IDs", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["emp:alice", ":employee/name", "?name"],
          ["emp:bob", ":employee/name", "?name"],
        ],
      };

      const deps = extractDependencies(query);

      expect(deps.boundEntityIds).toEqual(new Set(["emp:alice", "emp:bob"]));
    });
  });

  describe("multi-entity join queries", () => {
    it("extracts dependencies from join across entity types", () => {
      const query: DatalogQuery = {
        find: ["?empName", "?deptName"],
        where: [
          ["?emp", ":employee/name", "?empName"],
          ["?emp", ":employee/department", "?dept"],
          ["?dept", ":department/name", "?deptName"],
        ],
      };

      const deps = extractDependencies(query);

      expect(deps.attributes).toEqual(
        new Set([":employee/name", ":employee/department", ":department/name"]),
      );
      expect(deps.entityTypes).toEqual(new Set(["employee", "department"]));
      expect(deps.boundEntityTypes.size).toBe(0); // All variables
    });

    it("tracks bound entity types separately from all entity types", () => {
      // Query with bound employee but variable department
      const query: DatalogQuery = {
        find: ["?name", "?deptName"],
        where: [
          ["emp:alice", ":employee/name", "?name"],
          ["emp:alice", ":employee/department", "?dept"],
          ["?dept", ":department/name", "?deptName"],
        ],
      };

      const deps = extractDependencies(query);

      expect(deps.entityTypes).toEqual(new Set(["employee", "department"]));
      expect(deps.boundEntityIds).toEqual(new Set(["emp:alice"]));
      // Only employee has bound IDs, not department
      expect(deps.boundEntityTypes).toEqual(new Set(["employee"]));
    });
  });

  describe("not clauses", () => {
    it("extracts dependencies from pattern inside not clause", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?emp", ":employee/name", "?name"],
          ["not", ["?emp", ":employee/banned", true]],
        ],
      };

      const deps = extractDependencies(query);

      expect(deps.attributes).toEqual(new Set([":employee/name", ":employee/banned"]));
      expect(deps.entityTypes).toEqual(new Set(["employee"]));
    });
  });

  describe("or clauses", () => {
    it("extracts dependencies from all patterns in or clause", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          [
            "or",
            [
              ["?emp", ":employee/name", "?name"],
              ["?emp", ":contractor/name", "?name"],
            ],
          ],
        ],
      };

      const deps = extractDependencies(query);

      expect(deps.attributes).toEqual(new Set([":employee/name", ":contractor/name"]));
      expect(deps.entityTypes).toEqual(new Set(["employee", "contractor"]));
    });

    it("extracts dependencies from not alternatives in or clauses", () => {
      const query: DatalogQuery = {
        find: ["?step"],
        where: [
          ["?step", ":_schema/type", "WorkflowStep"],
          [
            "or",
            [
              ["not", ["?step", ":workflow-step/input-schema", "?is"]],
              ["not", ["?step", ":workflow-step/output-schema", "?os"]],
            ],
          ],
        ],
      };

      const deps = extractDependencies(query);

      expect(deps.attributes).toEqual(
        new Set([":_schema/type", ":workflow-step/input-schema", ":workflow-step/output-schema"]),
      );
      expect(deps.entityTypes).toEqual(new Set(["_schema", "workflow-step"]));
    });
  });

  describe("link clauses", () => {
    it("extracts link type and _link attributes from link clause", () => {
      const query: DatalogQuery = {
        find: ["?manager", "?employee"],
        where: [["link", "manages", "?manager", "?employee"]],
      };

      const deps = extractDependencies(query);

      expect(deps.linkTypes).toEqual(new Set(["manages"]));
      expect(deps.entityTypes).toEqual(new Set(["_link"]));
      expect(deps.attributes).toEqual(new Set([":_link/type", ":_link/source", ":_link/target"]));
    });

    it("extracts bound entity IDs from link clause source/target", () => {
      const query: DatalogQuery = {
        find: ["?employee"],
        where: [["link", "manages", "emp:alice", "?employee"]],
      };

      const deps = extractDependencies(query);

      expect(deps.boundEntityIds).toEqual(new Set(["emp:alice"]));
      expect(deps.linkTypes).toEqual(new Set(["manages"]));
    });
  });

  describe("rule applications", () => {
    it("extracts rule name from rule application", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "emp:alice", "?ancestor"]],
      };

      const deps = extractDependencies(query);

      expect(deps.ruleNames).toEqual(new Set(["ancestor"]));
      expect(deps.boundEntityIds).toEqual(new Set(["emp:alice"]));
    });

    it("extracts multiple rule names", () => {
      const query: DatalogQuery = {
        find: ["?result"],
        where: [
          ["connected", "node:a", "?mid"],
          ["reachable", "?mid", "?result"],
        ],
      };

      const deps = extractDependencies(query);

      expect(deps.ruleNames).toEqual(new Set(["connected", "reachable"]));
      expect(deps.boundEntityIds).toEqual(new Set(["node:a"]));
    });
  });

  describe("predicate clauses", () => {
    it("ignores predicate clauses (they filter, not read)", () => {
      const query: DatalogQuery = {
        find: ["?name", "?age"],
        where: [
          ["?emp", ":employee/name", "?name"],
          ["?emp", ":employee/age", "?age"],
          [">=", "?age", 18],
        ],
      };

      const deps = extractDependencies(query);

      expect(deps.attributes).toEqual(new Set([":employee/name", ":employee/age"]));
      // Should not include any predicate-related data
      expect(deps.boundEntityIds.size).toBe(0);
    });
  });

  describe("complex queries", () => {
    it("handles query with multiple clause types", () => {
      const query: DatalogQuery = {
        find: ["?empName", "?deptName"],
        where: [
          // Pattern clauses
          ["?emp", ":employee/name", "?empName"],
          ["?emp", ":employee/department", "?dept"],
          ["?dept", ":department/name", "?deptName"],
          // Not clause
          ["not", ["?emp", ":employee/inactive", true]],
          // Predicate clause
          ["!=", "?deptName", "Closed"],
        ],
      };

      const deps = extractDependencies(query);

      expect(deps.attributes).toEqual(
        new Set([
          ":employee/name",
          ":employee/department",
          ":department/name",
          ":employee/inactive",
        ]),
      );
      expect(deps.entityTypes).toEqual(new Set(["employee", "department"]));
    });

    it("handles empty where clause", () => {
      const query: DatalogQuery = {
        find: [],
        where: [],
      };

      const deps = extractDependencies(query);

      expect(deps.attributes.size).toBe(0);
      expect(deps.entityTypes.size).toBe(0);
      expect(deps.boundEntityIds.size).toBe(0);
      expect(deps.boundEntityTypes.size).toBe(0);
      expect(deps.linkTypes.size).toBe(0);
      expect(deps.ruleNames.size).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("handles attribute in entity position (should not treat as bound)", () => {
      // This is an unusual query but should not break
      const query: DatalogQuery = {
        find: ["?value"],
        where: [["?entity", ":employee/name", "?value"]],
      };

      const deps = extractDependencies(query);

      expect(deps.boundEntityIds.size).toBe(0); // ?entity is a variable
    });

    it("handles numeric/boolean constants in entity position", () => {
      // This is unusual but the function should handle it gracefully
      const query: DatalogQuery = {
        find: ["?attr"],
        where: [[123 as any, "?attr", "?value"]],
      };

      const deps = extractDependencies(query);

      // Numbers are not strings, so not added to boundEntityIds
      expect(deps.boundEntityIds.size).toBe(0);
    });

    it("handles 4-tuple pattern clauses (with tx binding)", () => {
      const query: DatalogQuery = {
        find: ["?name", "?tx"],
        where: [["?emp", ":employee/name", "?name", "?tx"]],
      };

      const deps = extractDependencies(query);

      expect(deps.attributes).toEqual(new Set([":employee/name"]));
      expect(deps.entityTypes).toEqual(new Set(["employee"]));
    });

    it("marks variable-attribute patterns as dynamic", () => {
      const query: DatalogQuery = {
        find: ["?attr", "?value"],
        where: [["emp:alice", "?attr", "?value"]],
      };

      const deps = extractDependencies(query);

      expect(deps.hasDynamicAttributes).toBe(true);
      expect(deps.boundEntityIds).toEqual(new Set(["emp:alice"]));
      expect(deps.entityTypes.size).toBe(0);
      expect(deps.boundEntityTypes.size).toBe(0);
    });
  });
});
