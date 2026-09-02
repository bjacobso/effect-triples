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
 *   pnpm test --filter @bjacobso/triplex-postgres -- test/integration/postgresql.test.ts
 */

import { describe, it, expect } from "vitest";
import { Effect, Layer, Redacted } from "effect";
import { DatabaseManager, Triples, unsafe, string, number, ref } from "@bjacobso/triplex";
import { compile } from "@bjacobso/triplex/datalog";
import { ConfigNode, ConfigStore } from "@bjacobso/triplex/config";
import {
  DatabaseRegistry,
  IdGeneratorLive,
  RuntimeClockLive,
  TripleStoreRuntimeLayer,
} from "@bjacobso/triplex/internal";
import { DatabaseManagerLive, DatabaseRegistryLive } from "@bjacobso/triplex-sql";
import { makePostgresqlBackend, PostgresqlDialect } from "@bjacobso/triplex-postgres";
import { makeTriplesConformanceSuite } from "@bjacobso/triplex-testkit";
import {
  PgConnectionInfo,
  PgContainerLayer,
  PgTestLayer,
  checkDockerAvailable,
} from "../fixtures/PgTestLayer.js";

// Skip all container-based tests if Docker is not available
const DOCKER_AVAILABLE = checkDockerAvailable();

describe("PostgreSQL Integration", () => {
  // Helper to run effects with PostgreSQL via testcontainers
  const runWithPostgres = <A, E>(effect: Effect.Effect<A, E, Triples>) =>
    Effect.runPromise(Effect.provide(effect, PgTestLayer));

  it.skipIf(!DOCKER_AVAILABLE)(
    "matches the shared temporal and query contract",
    { timeout: 120_000 },
    async () => {
      await runWithPostgres(makeTriplesConformanceSuite());
    },
  );

  it.skipIf(!DOCKER_AVAILABLE)(
    "isolates concurrent organization databases across pooled connections",
    { timeout: 120_000 },
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { url } = yield* PgConnectionInfo;
          const parsed = new URL(url);
          const backend = makePostgresqlBackend({
            host: parsed.hostname,
            port: Number(parsed.port),
            database: parsed.pathname.slice(1),
            username: decodeURIComponent(parsed.username),
            password: Redacted.make(decodeURIComponent(parsed.password)),
            pool: { min: 2, max: 4 },
          });
          const registry = DatabaseRegistryLive.pipe(
            Layer.provide(backend),
            Layer.provide(RuntimeClockLive),
          );
          const managerLayer = DatabaseManagerLive.pipe(
            Layer.provide(backend),
            Layer.provide(registry),
            Layer.provide(TripleStoreRuntimeLayer),
            Layer.provide(IdGeneratorLive),
          );
          const applicationLayer = Layer.merge(managerLayer, registry);

          yield* Effect.gen(function* () {
            const manager = yield* DatabaseManager;
            const access = yield* DatabaseRegistry;
            yield* Effect.all([manager.create("org-acme"), manager.create("org-globex")], {
              concurrency: "unbounded",
            });

            expect(yield* access.hasAccess("stranger", "org-acme")).toBe(false);
            yield* access.grantAccess("acme-operator", "org-acme", "member");
            expect(yield* access.hasAccess("acme-operator", "org-acme")).toBe(true);
            expect(yield* access.hasAccess("acme-operator", "org-globex")).toBe(false);

            const [acme, globex] = yield* Effect.all([
              manager.getTriples("org-acme"),
              manager.getTriples("org-globex"),
            ]);
            const [acmeWrite, globexWrite] = yield* Effect.all(
              [
                acme.transact(
                  [
                    {
                      op: "assert" as const,
                      entityId: "shared:worker",
                      entityType: "Worker",
                      attribute: ":worker/name",
                      value: string("Acme worker"),
                    },
                  ],
                  { commandId: "acme-command", configSnapshot: "acme-config" },
                ),
                globex.transact(
                  [
                    {
                      op: "assert" as const,
                      entityId: "shared:worker",
                      entityType: "Worker",
                      attribute: ":worker/name",
                      value: string("Globex worker"),
                    },
                  ],
                  { commandId: "globex-command", configSnapshot: "globex-config" },
                ),
              ],
              { concurrency: "unbounded" },
            );

            const query = {
              find: ["?name"],
              where: [["?worker", ":worker/name", "?name"]],
            } as const;
            const [acmeQuery, globexQuery, acmeFeed, globexFeed] = yield* Effect.all(
              [acme.query(query), globex.query(query), acme.transactions(), globex.transactions()],
              { concurrency: "unbounded" },
            );

            expect(acmeQuery.results).toEqual([{ "?name": "Acme worker" }]);
            expect(globexQuery.results).toEqual([{ "?name": "Globex worker" }]);
            expect(acmeFeed.transactions.some((tx) => tx.commandId === "globex-command")).toBe(
              false,
            );
            expect(globexFeed.transactions.some((tx) => tx.commandId === "acme-command")).toBe(
              false,
            );

            yield* Effect.all([
              acme.assert({
                entityId: "acme:worker:second",
                entityType: "Worker",
                attribute: ":worker/name",
                value: string("Zed at Acme"),
              }),
              globex.assert({
                entityId: "globex:worker:second",
                entityType: "Worker",
                attribute: ":worker/name",
                value: string("Zed at Globex"),
              }),
            ]);
            const pageRequest = {
              inner: {
                find: ["?worker", "?name"],
                where: [["?worker", ":worker/name", "?name"]],
              },
              orderBy: [{ variable: "?name" as const, direction: "asc" as const }],
              limit: 1,
            } as const;
            const acmePage = yield* acme.queryPage(pageRequest);
            expect(acmePage.nextCursor).toBeDefined();
            const crossScope = yield* globex
              .queryPage({ ...pageRequest, cursor: acmePage.nextCursor })
              .pipe(Effect.flip);
            expect(crossScope).toMatchObject({
              _tag: "PaginationCursorError",
              reason: "scope_mismatch",
            });

            const commitConfig = (triples: typeof acme, label: string) =>
              Effect.gen(function* () {
                const node = yield* ConfigNode.make({
                  kind: "policy",
                  key: "worker-access",
                  attrs: { label },
                });
                return yield* Effect.gen(function* () {
                  const config = yield* ConfigStore.ConfigStore;
                  return yield* config.commit({ label, objects: [node], ref: "live" });
                }).pipe(
                  Effect.provide(
                    ConfigStore.layer.pipe(Layer.provide(Layer.succeed(Triples, triples))),
                  ),
                );
              });
            const [acmeConfig, globexConfig] = yield* Effect.all(
              [commitConfig(acme, "Acme live"), commitConfig(globex, "Globex live")],
              { concurrency: "unbounded" },
            );
            expect(acmeConfig.snapshot.rootCid).not.toBe(globexConfig.snapshot.rootCid);

            const acmeForeignRef = yield* acme.match({
              entityId: ConfigStore.entityId.ref("live"),
              value: ref(ConfigStore.entityId.snapshot(globexConfig.snapshot.id)),
            });
            expect(acmeForeignRef).toHaveLength(0);

            const [acmeSnapshots, globexSnapshots] = yield* Effect.all([
              manager.getSnapshotService("org-acme"),
              manager.getSnapshotService("org-globex"),
            ]);
            const [acmeSnapshot, globexSnapshot] = yield* Effect.all([
              acmeSnapshots!.at("shared:worker", acmeWrite.txId),
              globexSnapshots!.at("shared:worker", globexWrite.txId),
            ]);
            expect(acmeSnapshot?.attributes[":worker/name"]).toEqual({
              type: "string",
              value: "Acme worker",
            });
            expect(globexSnapshot?.attributes[":worker/name"]).toEqual({
              type: "string",
              value: "Globex worker",
            });

            yield* Effect.all([manager.delete("org-acme"), manager.delete("org-globex")]);
          }).pipe(Effect.provide(applicationLayer));
        }).pipe(Effect.provide(PgContainerLayer)),
      );
    },
  );

  it("rejects crafted database identifiers", () => {
    expect(() => unsafe.databaseId("public")).not.toThrow();
    expect(() => unsafe.databaseId("public;drop-schema-public")).toThrow();
    expect(() => unsafe.databaseId("triplex_system")).toThrow();
    expect(() => unsafe.databaseId("../other")).toThrow();
  });

  describe("basic operations (requires Docker)", () => {
    it.skipIf(!DOCKER_AVAILABLE)(
      "should create and retrieve a triple",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const store = yield* Triples;

            const triple = yield* store.assert({
              entityId: "pg-test-1",
              attribute: ":name",
              value: string("PostgreSQL Test"),
              entityType: "test",
            });

            const retrieved = yield* store.get(triple.id);
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
          const store = yield* Triples;

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

          const entity = yield* store.entity("pg-query-1" as any);

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
            const store = yield* Triples;
            const datalog = yield* Triples;

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
            const store = yield* Triples;
            const datalog = yield* Triples;

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
            const datalog = yield* Triples;

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
            const store = yield* Triples;
            const datalog = yield* Triples;

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
