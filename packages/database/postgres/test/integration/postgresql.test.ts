/**
 * PostgreSQL Integration Tests
 *
 * These tests verify that the triple store and Datalog queries work correctly
 * with PostgreSQL, including proper dialect handling.
 *
 * Uses testcontainers to automatically spin up a PostgreSQL container.
 * Tests are skipped if Docker is not available.
 *
 * Run with:
 *   pnpm test --filter @open-ontology/database-postgres -- test/integration/postgresql.test.ts
 */

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { TripleStore, Datalog, string, number, ref, compile } from "@open-ontology/database";
import { PostgresqlDialect } from "@open-ontology/database-postgres";
import { PgFullTestLayer, checkDockerAvailable } from "../fixtures/PgTestLayer.js";

// Skip all container-based tests if Docker is not available
const DOCKER_AVAILABLE = checkDockerAvailable();

describe("PostgreSQL Integration", () => {
  // Helper to run effects with PostgreSQL via testcontainers
  const runWithPostgres = <A, E>(effect: Effect.Effect<A, E, TripleStore | Datalog>) =>
    Effect.runPromise(Effect.provide(effect, PgFullTestLayer));

  describe("basic operations (requires Docker)", () => {
    it.skipIf(!DOCKER_AVAILABLE)(
      "should create and retrieve a triple",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const store = yield* TripleStore;

            const triple = yield* store.assert({
              entityId: "pg-test-1",
              attribute: ":name",
              value: string("PostgreSQL Test"),
              entityType: "test",
            });

            const retrieved = yield* store.getTriple(triple.id);
            yield* store.retract(triple.id);

            return { triple, retrieved };
          }),
        );

        expect(result.triple.entityId).toBe("pg-test-1");
        expect(result.retrieved?.entityId).toBe("pg-test-1");
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)("should query triples", { timeout: 60_000 }, async () => {
      const result = await runWithPostgres(
        Effect.gen(function* () {
          const store = yield* TripleStore;

          const t1 = yield* store.assert({
            entityId: "pg-query-1",
            attribute: ":name",
            value: string("Alice"),
            entityType: "person",
          });
          const t2 = yield* store.assert({
            entityId: "pg-query-1",
            attribute: ":age",
            value: number(30),
          });
          const t3 = yield* store.assert({
            entityId: "pg-query-2",
            attribute: ":name",
            value: string("Bob"),
            entityType: "person",
          });

          const entity = yield* store.getEntity("pg-query-1" as any);

          yield* store.retract(t1.id);
          yield* store.retract(t2.id);
          yield* store.retract(t3.id);

          return { entity };
        }),
      );

      expect(result.entity.length).toBe(2);
    });
  });

  describe("Datalog queries (requires Docker)", () => {
    it.skipIf(!DOCKER_AVAILABLE)(
      "should execute a Datalog query with PostgreSQL dialect",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const store = yield* TripleStore;
            const datalog = yield* Datalog;

            const triples = yield* Effect.all([
              store.assert({
                entityId: "pg-dl-1",
                attribute: ":person/name",
                value: string("Alice"),
              }),
              store.assert({ entityId: "pg-dl-1", attribute: ":person/age", value: number(30) }),
              store.assert({
                entityId: "pg-dl-2",
                attribute: ":person/name",
                value: string("Bob"),
              }),
              store.assert({ entityId: "pg-dl-2", attribute: ":person/age", value: number(25) }),
            ]);

            const queryResult = yield* datalog.query({
              find: ["?name", "?age"],
              where: [
                ["?person", ":person/name", "?name"],
                ["?person", ":person/age", "?age"],
              ],
            });

            yield* Effect.all(triples.map((t) => store.retract(t.id)));
            return queryResult;
          }),
        );

        expect(result.results.length).toBe(2);
        const names = result.results.map((r: Record<string, unknown>) => r["?name"]);
        expect(names).toContain("Alice");
        expect(names).toContain("Bob");
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "should execute a Datalog query with predicate filter",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const store = yield* TripleStore;
            const datalog = yield* Datalog;

            const triples = yield* Effect.all([
              store.assert({
                entityId: "pg-pred-1",
                attribute: ":employee/name",
                value: string("Senior"),
              }),
              store.assert({
                entityId: "pg-pred-1",
                attribute: ":employee/age",
                value: number(45),
              }),
              store.assert({
                entityId: "pg-pred-2",
                attribute: ":employee/name",
                value: string("Junior"),
              }),
              store.assert({
                entityId: "pg-pred-2",
                attribute: ":employee/age",
                value: number(22),
              }),
            ]);

            const queryResult = yield* datalog.query({
              find: ["?name"],
              where: [
                ["?e", ":employee/name", "?name"],
                ["?e", ":employee/age", "?age"],
                [">=", "?age", 30],
              ],
            });

            yield* Effect.all(triples.map((t) => store.retract(t.id)));
            return queryResult;
          }),
        );

        expect(result.results.length).toBe(1);
        expect((result.results[0] as Record<string, unknown>)["?name"]).toBe("Senior");
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "should execute explain and report postgresql backend",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const datalog = yield* Datalog;

            const explained = yield* datalog.explain({
              find: ["?name"],
              where: [["?p", ":name", "?name"]],
            });

            return explained;
          }),
        );

        expect(result.queryPlan.backend).toBe("postgresql");
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "should execute a join query across entities",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const store = yield* TripleStore;
            const datalog = yield* Datalog;

            const triples = yield* Effect.all([
              store.assert({
                entityId: "pg-dept-1",
                attribute: ":department/name",
                value: string("Engineering"),
              }),
              store.assert({
                entityId: "pg-emp-1",
                attribute: ":employee/name",
                value: string("Alice"),
              }),
              store.assert({
                entityId: "pg-emp-1",
                attribute: ":employee/department",
                value: ref("pg-dept-1"),
              }),
            ]);

            const queryResult = yield* datalog.query({
              find: ["?empName", "?deptName"],
              where: [
                ["?emp", ":employee/name", "?empName"],
                ["?emp", ":employee/department", "?dept"],
                ["?dept", ":department/name", "?deptName"],
              ],
            });

            yield* Effect.all(triples.map((t) => store.retract(t.id)));
            return queryResult;
          }),
        );

        expect(result.results.length).toBe(1);
        expect((result.results[0] as Record<string, unknown>)["?empName"]).toBe("Alice");
        expect((result.results[0] as Record<string, unknown>)["?deptName"]).toBe("Engineering");
      },
    );
  });

  describe("dialect-specific SQL", () => {
    it("should generate PostgreSQL-compatible LIMIT/OFFSET", () => {
      const query = {
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
        offset: 10,
      } as const;

      const { sql } = compile(query, PostgresqlDialect);

      expect(sql).not.toContain("LIMIT -1");
      expect(sql).toContain("OFFSET 10");
    });

    it("should generate SQLite-compatible LIMIT/OFFSET by default", () => {
      const query = {
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
        offset: 10,
      } as const;

      const { sql } = compile(query);

      expect(sql).toContain("LIMIT -1");
      expect(sql).toContain("OFFSET 10");
    });

    it("should use $1, $2 parameters for PostgreSQL", () => {
      const query = {
        find: ["?name"],
        where: [
          ["?person", ":person/name", "?name"],
          ["?person", ":person/age", 30],
        ],
      } as const;

      const { sql } = compile(query, PostgresqlDialect);

      expect(sql).toMatch(/\$\d+/);
      expect(sql).not.toMatch(/\?(?!\w)/);
    });
  });
});
