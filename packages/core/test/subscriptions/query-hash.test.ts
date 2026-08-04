import { describe, it, expect } from "vitest";
import { hashQuery } from "../../src/subscriptions/query-hash.js";
import type { DatalogQuery } from "../../src/Datalog.js";

describe("hashQuery", () => {
  describe("consistency", () => {
    it("produces same hash for identical queries", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      const hash1 = hashQuery(query);
      const hash2 = hashQuery(query);

      expect(hash1).toBe(hash2);
    });

    it("produces same hash for structurally identical queries", () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      expect(hashQuery(query1)).toBe(hashQuery(query2));
    });

    it("returns a number", () => {
      const query: DatalogQuery = {
        find: ["?x"],
        where: [["?x", ":foo/bar", "?y"]],
      };

      expect(typeof hashQuery(query)).toBe("number");
    });

    it("produces deterministic results across calls", () => {
      const query: DatalogQuery = {
        find: ["?name", "?age"],
        where: [
          ["?p", ":person/name", "?name"],
          ["?p", ":person/age", "?age"],
        ],
      };

      // Call multiple times
      const hashes = Array.from({ length: 10 }, () => hashQuery(query));

      // All should be identical
      expect(new Set(hashes).size).toBe(1);
    });
  });

  describe("differentiation", () => {
    it("produces different hash for different find clauses", () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?email"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      expect(hashQuery(query1)).not.toBe(hashQuery(query2));
    });

    it("produces different hash for different where clauses", () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/email", "?name"]],
      };

      expect(hashQuery(query1)).not.toBe(hashQuery(query2));
    });

    it("produces different hash for different number of where clauses", () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?emp", ":employee/name", "?name"],
          ["?emp", ":employee/active", true],
        ],
      };

      expect(hashQuery(query1)).not.toBe(hashQuery(query2));
    });

    it("produces different hash with vs without aggregate", () => {
      const query1: DatalogQuery = {
        find: ["?dept", "?count"],
        where: [["?emp", ":employee/department", "?dept"]],
      };
      const query2: DatalogQuery = {
        find: ["?dept", "?count"],
        where: [["?emp", ":employee/department", "?dept"]],
        aggregate: [["count", "?emp", "?count"]],
      };

      expect(hashQuery(query1)).not.toBe(hashQuery(query2));
    });

    it("produces different hash with vs without limit", () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
        limit: 10,
      };

      expect(hashQuery(query1)).not.toBe(hashQuery(query2));
    });

    it("produces different hash with different limits", () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
        limit: 10,
      };
      const query2: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
        limit: 20,
      };

      expect(hashQuery(query1)).not.toBe(hashQuery(query2));
    });

    it("produces different hash with vs without offset", () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
        offset: 10,
      };

      expect(hashQuery(query1)).not.toBe(hashQuery(query2));
    });

    it("produces different hash for different orderBy", () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
        orderBy: [{ variable: "?name", direction: "asc" }],
      };
      const query2: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
        orderBy: [{ variable: "?name", direction: "desc" }],
      };

      expect(hashQuery(query1)).not.toBe(hashQuery(query2));
    });
  });

  describe("complex queries", () => {
    it("handles not clauses", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?emp", ":employee/name", "?name"],
          ["not", ["?emp", ":employee/banned", true]],
        ],
      };

      const hash = hashQuery(query);
      expect(typeof hash).toBe("number");
      expect(hashQuery(query)).toBe(hash);
    });

    it("handles or clauses", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?emp", ":employee/name", "?name"],
          [
            "or",
            [
              ["?emp", ":employee/role", "manager"],
              ["?emp", ":employee/role", "director"],
            ],
          ],
        ],
      };

      const hash = hashQuery(query);
      expect(typeof hash).toBe("number");
      expect(hashQuery(query)).toBe(hash);
    });

    it("handles link clauses", () => {
      const query: DatalogQuery = {
        find: ["?manager", "?employee"],
        where: [["link", "manages", "?manager", "?employee"]],
      };

      const hash = hashQuery(query);
      expect(typeof hash).toBe("number");
      expect(hashQuery(query)).toBe(hash);
    });

    it("handles predicate clauses", () => {
      const query: DatalogQuery = {
        find: ["?name", "?age"],
        where: [
          ["?p", ":person/name", "?name"],
          ["?p", ":person/age", "?age"],
          [">=", "?age", 18],
        ],
      };

      const hash = hashQuery(query);
      expect(typeof hash).toBe("number");
      expect(hashQuery(query)).toBe(hash);
    });

    it("handles rule application clauses", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
      };

      const hash = hashQuery(query);
      expect(typeof hash).toBe("number");
      expect(hashQuery(query)).toBe(hash);
    });

    it("handles having clauses", () => {
      const query: DatalogQuery = {
        find: ["?dept", "?count"],
        where: [["?emp", ":employee/department", "?dept"]],
        aggregate: [["count", "?emp", "?count"]],
        having: [[">=", "?count", 5]],
      };

      const hash = hashQuery(query);
      expect(typeof hash).toBe("number");
      expect(hashQuery(query)).toBe(hash);
    });
  });

  describe("reactivity key usage", () => {
    it("hash can be used as a reactivity key string", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      const hash = hashQuery(query);

      // The hash can be converted to a string for use as reactivityKey
      const reactivityKey = `query:${hash}`;
      expect(reactivityKey).toMatch(/^query:-?\d+$/);
    });

    it("identical queries produce same reactivity key", () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      const key1 = `query:${hashQuery(query1)}`;
      const key2 = `query:${hashQuery(query2)}`;

      expect(key1).toBe(key2);
    });

    it("different queries produce different reactivity keys", () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?email"],
        where: [["?emp", ":employee/email", "?email"]],
      };

      const key1 = `query:${hashQuery(query1)}`;
      const key2 = `query:${hashQuery(query2)}`;

      expect(key1).not.toBe(key2);
    });
  });
});
