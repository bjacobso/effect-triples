import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { makeSubscriptionManager } from "../../src/subscriptions/SubscriptionManager.js";
import type { SubscriptionManagerService } from "../../src/subscriptions/SubscriptionManager.js";
import type { TripleChange } from "../../src/subscriptions/types.js";
import type { DatalogQuery } from "../../src/Datalog.js";
import { hashQuery } from "../../src/subscriptions/query-hash.js";

// Helper to create a change
const change = (
  entityId: string,
  attribute: string,
  operation: "assert" | "retract" = "assert",
): TripleChange => ({ entityId, attribute, operation });

describe("SubscriptionManager", () => {
  let manager: SubscriptionManagerService;

  beforeEach(async () => {
    manager = await Effect.runPromise(makeSubscriptionManager);
  });

  describe("register", () => {
    it("registers a subscription and extracts dependencies", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      const sub = await Effect.runPromise(manager.register("sub1", query));

      expect(sub.id).toBe("sub1");
      expect(sub.query).toBe(query);
      expect(sub.dependencies.attributes).toEqual(new Set([":employee/name"]));
      expect(sub.dependencies.entityTypes).toEqual(new Set(["employee"]));
    });

    it("registers subscription with clientId", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      const sub = await Effect.runPromise(manager.register("sub1", query, "client-123"));

      expect(sub.clientId).toBe("client-123");
    });

    it("overwrites subscription with same id", async () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?email"],
        where: [["?emp", ":employee/email", "?email"]],
      };

      await Effect.runPromise(manager.register("sub1", query1));
      await Effect.runPromise(manager.register("sub1", query2));

      const count = await Effect.runPromise(manager.count());
      expect(count).toBe(1);

      const sub = await Effect.runPromise(manager.get("sub1"));
      expect(sub?.dependencies.attributes).toEqual(new Set([":employee/email"]));
    });
  });

  describe("unregister", () => {
    it("removes a subscription", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));
      expect(await Effect.runPromise(manager.count())).toBe(1);

      await Effect.runPromise(manager.unregister("sub1"));
      expect(await Effect.runPromise(manager.count())).toBe(0);
    });

    it("does nothing when unregistering non-existent subscription", async () => {
      // Should not throw
      await Effect.runPromise(manager.unregister("non-existent"));
      expect(await Effect.runPromise(manager.count())).toBe(0);
    });
  });

  describe("get", () => {
    it("returns subscription by id", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));

      const sub = await Effect.runPromise(manager.get("sub1"));
      expect(sub).toBeDefined();
      expect(sub?.id).toBe("sub1");
    });

    it("returns undefined for non-existent subscription", async () => {
      const sub = await Effect.runPromise(manager.get("non-existent"));
      expect(sub).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns all subscriptions", async () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?dept"],
        where: [["?d", ":department/name", "?dept"]],
      };

      await Effect.runPromise(manager.register("sub1", query1));
      await Effect.runPromise(manager.register("sub2", query2));

      const subs = await Effect.runPromise(manager.list());

      expect(subs).toHaveLength(2);
      expect(subs.map((s) => s.id).sort()).toEqual(["sub1", "sub2"]);
    });

    it("returns empty array when no subscriptions", async () => {
      const subs = await Effect.runPromise(manager.list());
      expect(subs).toHaveLength(0);
    });
  });

  describe("count", () => {
    it("returns correct count", async () => {
      expect(await Effect.runPromise(manager.count())).toBe(0);

      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));
      expect(await Effect.runPromise(manager.count())).toBe(1);

      await Effect.runPromise(manager.register("sub2", query));
      expect(await Effect.runPromise(manager.count())).toBe(2);
    });
  });

  describe("clear", () => {
    it("removes all subscriptions", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));
      await Effect.runPromise(manager.register("sub2", query));
      expect(await Effect.runPromise(manager.count())).toBe(2);

      await Effect.runPromise(manager.clear());
      expect(await Effect.runPromise(manager.count())).toBe(0);
    });
  });

  describe("checkAffected", () => {
    it("returns empty when no subscriptions", async () => {
      const result = await Effect.runPromise(
        manager.checkAffected([change("emp:alice", ":employee/name")]),
      );

      expect(result.affected).toHaveLength(0);
      expect(result.unaffected).toHaveLength(0);
    });

    it("partitions subscriptions into affected and unaffected", async () => {
      const employeeQuery: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const departmentQuery: DatalogQuery = {
        find: ["?name"],
        where: [["?dept", ":department/name", "?name"]],
      };

      await Effect.runPromise(manager.register("emp-sub", employeeQuery));
      await Effect.runPromise(manager.register("dept-sub", departmentQuery));

      // Change to employee data
      const result = await Effect.runPromise(
        manager.checkAffected([change("emp:alice", ":employee/name")]),
      );

      expect(result.affected).toHaveLength(1);
      expect(result.affected[0]?.id).toBe("emp-sub");

      expect(result.unaffected).toHaveLength(1);
      expect(result.unaffected[0]?.id).toBe("dept-sub");
    });

    it("provides detailed results per subscription", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));

      const result = await Effect.runPromise(
        manager.checkAffected([change("emp:alice", ":employee/name")]),
      );

      expect(result.details.has("sub1")).toBe(true);
      const detail = result.details.get("sub1");
      expect(detail?.affected).toBe(true);
      expect(detail?.matchingChanges).toHaveLength(1);
    });

    it("handles multiple subscriptions watching same data", async () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?name", "?email"],
        where: [
          ["?emp", ":employee/name", "?name"],
          ["?emp", ":employee/email", "?email"],
        ],
      };

      await Effect.runPromise(manager.register("sub1", query1));
      await Effect.runPromise(manager.register("sub2", query2));

      // Both subscriptions read :employee/name
      const result = await Effect.runPromise(
        manager.checkAffected([change("emp:alice", ":employee/name")]),
      );

      expect(result.affected).toHaveLength(2);
    });

    it("handles entity-scoped subscriptions correctly", async () => {
      // Two subscriptions watching different specific employees
      const aliceQuery: DatalogQuery = {
        find: ["?name"],
        where: [["emp:alice", ":employee/name", "?name"]],
      };
      const bobQuery: DatalogQuery = {
        find: ["?name"],
        where: [["emp:bob", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("alice-sub", aliceQuery));
      await Effect.runPromise(manager.register("bob-sub", bobQuery));

      // Change to Alice's data
      const result = await Effect.runPromise(
        manager.checkAffected([change("emp:alice", ":employee/name")]),
      );

      expect(result.affected).toHaveLength(1);
      expect(result.affected[0]?.id).toBe("alice-sub");

      expect(result.unaffected).toHaveLength(1);
      expect(result.unaffected[0]?.id).toBe("bob-sub");
    });

    it("handles batch of changes affecting multiple subscriptions", async () => {
      const employeeQuery: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const departmentQuery: DatalogQuery = {
        find: ["?name"],
        where: [["?dept", ":department/name", "?name"]],
      };
      const productQuery: DatalogQuery = {
        find: ["?name"],
        where: [["?prod", ":product/name", "?name"]],
      };

      await Effect.runPromise(manager.register("emp-sub", employeeQuery));
      await Effect.runPromise(manager.register("dept-sub", departmentQuery));
      await Effect.runPromise(manager.register("prod-sub", productQuery));

      // Changes to employee and department, but not product
      const result = await Effect.runPromise(
        manager.checkAffected([
          change("emp:alice", ":employee/name"),
          change("dept:eng", ":department/name"),
        ]),
      );

      expect(result.affected).toHaveLength(2);
      expect(result.affected.map((s) => s.id).sort()).toEqual(["dept-sub", "emp-sub"]);

      expect(result.unaffected).toHaveLength(1);
      expect(result.unaffected[0]?.id).toBe("prod-sub");
    });

    it("handles no changes affecting any subscription", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));
      await Effect.runPromise(manager.register("sub2", query));

      // Change to unrelated data
      const result = await Effect.runPromise(
        manager.checkAffected([change("product:123", ":product/name")]),
      );

      expect(result.affected).toHaveLength(0);
      expect(result.unaffected).toHaveLength(2);
    });
  });

  describe("concurrent operations", () => {
    it("handles concurrent registrations", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      // Register 10 subscriptions concurrently
      await Effect.runPromise(
        Effect.all(
          Array.from({ length: 10 }, (_, i) => manager.register(`sub${i}`, query)),
          { concurrency: "unbounded" },
        ),
      );

      expect(await Effect.runPromise(manager.count())).toBe(10);
    });

    it("handles concurrent checkAffected", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));

      // Run 10 checkAffected concurrently
      const results = await Effect.runPromise(
        Effect.all(
          Array.from({ length: 10 }, () =>
            manager.checkAffected([change("emp:alice", ":employee/name")]),
          ),
          { concurrency: "unbounded" },
        ),
      );

      // All should return the same result
      for (const result of results) {
        expect(result.affected).toHaveLength(1);
      }
    });
  });

  describe("query hashing", () => {
    it("sets queryHash on registered subscription", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      const sub = await Effect.runPromise(manager.register("sub1", query));

      expect(typeof sub.queryHash).toBe("number");
      expect(sub.queryHash).toBe(hashQuery(query));
    });

    it("identical queries have same queryHash", async () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      const sub1 = await Effect.runPromise(manager.register("sub1", query1));
      const sub2 = await Effect.runPromise(manager.register("sub2", query2));

      expect(sub1.queryHash).toBe(sub2.queryHash);
    });

    it("different queries have different queryHash", async () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?email"],
        where: [["?emp", ":employee/email", "?email"]],
      };

      const sub1 = await Effect.runPromise(manager.register("sub1", query1));
      const sub2 = await Effect.runPromise(manager.register("sub2", query2));

      expect(sub1.queryHash).not.toBe(sub2.queryHash);
    });

    it("getQueryHash returns same hash as hashQuery", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      const hash = manager.getQueryHash(query);
      expect(hash).toBe(hashQuery(query));
    });
  });

  describe("findByQueryHash", () => {
    it("returns subscriptions with matching hash", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));
      await Effect.runPromise(manager.register("sub2", query)); // Same query

      const qHash = hashQuery(query);
      const found = await Effect.runPromise(manager.findByQueryHash(qHash));

      expect(found).toHaveLength(2);
      expect(found.map((s) => s.id).sort()).toEqual(["sub1", "sub2"]);
    });

    it("returns empty array for unknown hash", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));

      const unknownHash = 999999999;
      const found = await Effect.runPromise(manager.findByQueryHash(unknownHash));

      expect(found).toHaveLength(0);
    });

    it("only returns subscriptions with exact hash match", async () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?email"],
        where: [["?emp", ":employee/email", "?email"]],
      };

      await Effect.runPromise(manager.register("sub1", query1));
      await Effect.runPromise(manager.register("sub2", query2));

      const hash1 = hashQuery(query1);
      const found = await Effect.runPromise(manager.findByQueryHash(hash1));

      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe("sub1");
    });
  });

  describe("hash index maintenance", () => {
    it("removes subscription from hash index on unregister", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));
      const qHash = hashQuery(query);

      // Verify it's in the index
      let found = await Effect.runPromise(manager.findByQueryHash(qHash));
      expect(found).toHaveLength(1);

      // Unregister
      await Effect.runPromise(manager.unregister("sub1"));

      // Verify it's removed from index
      found = await Effect.runPromise(manager.findByQueryHash(qHash));
      expect(found).toHaveLength(0);
    });

    it("handles multiple subscriptions per hash correctly on unregister", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));
      await Effect.runPromise(manager.register("sub2", query));
      const qHash = hashQuery(query);

      // Unregister one
      await Effect.runPromise(manager.unregister("sub1"));

      // Other should still be in index
      const found = await Effect.runPromise(manager.findByQueryHash(qHash));
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe("sub2");
    });

    it("clears hash index on clear()", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));
      await Effect.runPromise(manager.register("sub2", query));
      const qHash = hashQuery(query);

      await Effect.runPromise(manager.clear());

      const found = await Effect.runPromise(manager.findByQueryHash(qHash));
      expect(found).toHaveLength(0);
    });

    it("updates hash index when replacing subscription with different query", async () => {
      const query1: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };
      const query2: DatalogQuery = {
        find: ["?email"],
        where: [["?emp", ":employee/email", "?email"]],
      };

      // Register with first query
      await Effect.runPromise(manager.register("sub1", query1));
      const hash1 = hashQuery(query1);

      // Verify it's in the first hash index
      let found = await Effect.runPromise(manager.findByQueryHash(hash1));
      expect(found).toHaveLength(1);

      // Replace with second query (same ID)
      await Effect.runPromise(manager.register("sub1", query2));
      const hash2 = hashQuery(query2);

      // Should be removed from old hash index
      found = await Effect.runPromise(manager.findByQueryHash(hash1));
      expect(found).toHaveLength(0);

      // Should be in new hash index
      found = await Effect.runPromise(manager.findByQueryHash(hash2));
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe("sub1");
    });

    it("handles replacing subscription with same query (no index change needed)", async () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?emp", ":employee/name", "?name"]],
      };

      await Effect.runPromise(manager.register("sub1", query));
      const qHash = hashQuery(query);

      // Re-register with same query but different clientId
      await Effect.runPromise(manager.register("sub1", query, "new-client"));

      // Should still be in index exactly once
      const found = await Effect.runPromise(manager.findByQueryHash(qHash));
      expect(found).toHaveLength(1);
      expect(found[0]?.clientId).toBe("new-client");
    });
  });
});
