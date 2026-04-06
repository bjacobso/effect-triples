/**
 * Testcontainers-based PostgreSQL test layer.
 *
 * Spins up a PostgreSQL Docker container, runs migrations, and provides
 * TripleStore + Datalog services backed by PostgreSQL.
 *
 * Follows the same acquireRelease pattern as FdbTestLayer.
 *
 * Usage with @effect/vitest:
 *
 * ```ts
 * import { layer } from "@effect/vitest"
 * import { PgFullTestLayer } from "../fixtures/PgTestLayer.js"
 *
 * const pgAvailable = checkDockerAvailable()
 * const describePg = pgAvailable
 *   ? layer(PgFullTestLayer, { timeout: "60 seconds" })
 *   : (name: string, _fn: () => void) => describe.skip(name, () => {})
 *
 * describePg("PostgreSQL tests", (it) => {
 *   it.effect("queries work", () =>
 *     Effect.gen(function* () {
 *       const store = yield* TripleStore
 *       // ...
 *     })
 *   )
 * })
 * ```
 *
 * Environment overrides:
 *   PG_TEST_IMAGE=postgres:17-alpine  (default)
 */

import { Context, Effect, Layer } from "effect";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import { CurrentDialect, TripleStoreLive } from "@open-ontology/database";
import { DatalogLive, SqlQueryExecutorLive } from "@open-ontology/database-sql";
import {
  makePostgresqlLayerFromUrl,
  PostgresqlAdapterLive,
  PostgresqlDialect,
} from "@open-ontology/database-postgres";

// ─── Constants ─────────────────────────────────────────────────────────────

const PG_IMAGE = process.env["PG_TEST_IMAGE"] ?? "postgres:17-alpine";
const PG_PORT = 5432;
const PG_USER = "test";
const PG_PASSWORD = "test";
const PG_DATABASE = "test_ontology";
const PG_STARTUP_TIMEOUT_MS = 60_000;

// ─── Container lifecycle ───────────────────────────────────────────────────

const acquirePgContainer = Effect.gen(function* () {
  yield* Effect.logInfo("Starting PostgreSQL container...");

  const container = yield* Effect.tryPromise({
    try: () =>
      new GenericContainer(PG_IMAGE)
        .withEnvironment({
          POSTGRES_USER: PG_USER,
          POSTGRES_PASSWORD: PG_PASSWORD,
          POSTGRES_DB: PG_DATABASE,
        })
        .withExposedPorts(PG_PORT)
        .withTmpFs({ "/var/lib/postgresql/data": "rw" })
        .withStartupTimeout(PG_STARTUP_TIMEOUT_MS)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .start(),
    catch: (e) => new Error(`Failed to start PostgreSQL container: ${String(e)}`),
  }).pipe(Effect.orDie);

  const host = container.getHost();
  const port = container.getMappedPort(PG_PORT);
  const url = `postgresql://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DATABASE}`;

  yield* Effect.logInfo(`PostgreSQL container started at ${host}:${port}`);

  return { container, url };
});

const releasePgContainer = ({ container }: { container: StartedTestContainer }) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Stopping PostgreSQL container...");
    yield* Effect.tryPromise({
      try: () => container.stop(),
      catch: (e) => new Error(`Failed to stop PostgreSQL container: ${String(e)}`),
    }).pipe(Effect.orDie);
    yield* Effect.logInfo("PostgreSQL container stopped");
  });

// ─── Context tag ───────────────────────────────────────────────────────────

/**
 * Tag carrying the connection URL from the running container.
 */
class PgConnectionInfo extends Context.Tag("test/PgConnectionInfo")<
  PgConnectionInfo,
  { readonly url: string }
>() {}

// ─── Layers ────────────────────────────────────────────────────────────────

/**
 * Layer that manages the PostgreSQL container lifecycle.
 */
const PgContainerLayer: Layer.Layer<PgConnectionInfo> = Layer.scoped(
  PgConnectionInfo,
  Effect.acquireRelease(acquirePgContainer, releasePgContainer).pipe(
    Effect.map(({ url }) => ({ url })),
  ),
);

/**
 * SqlClient layer that connects to the containerized PostgreSQL.
 * Uses makePostgresqlLayerFromUrl which also runs migrations.
 */
const PgSqlClientLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const { url } = yield* PgConnectionInfo;
    return makePostgresqlLayerFromUrl(url);
  }),
);

/**
 * TripleStore backed by containerized PostgreSQL.
 */
export const PgTestLayer = TripleStoreLive.pipe(
  Layer.provideMerge(PostgresqlAdapterLive),
  Layer.provide(PgSqlClientLayer),
  Layer.provide(PgContainerLayer),
);

/**
 * TripleStore + Datalog + CurrentDialect backed by containerized PostgreSQL.
 *
 * Complete test layer for PostgreSQL integration tests.
 */
export const PgFullTestLayer = Layer.mergeAll(
  TripleStoreLive.pipe(Layer.provide(PostgresqlAdapterLive)),
  DatalogLive.pipe(
    Layer.provide(TripleStoreLive.pipe(Layer.provide(PostgresqlAdapterLive))),
    Layer.provide(SqlQueryExecutorLive),
  ),
).pipe(
  Layer.provide(Layer.succeed(CurrentDialect, PostgresqlDialect)),
  Layer.provide(PgSqlClientLayer),
  Layer.provide(PgContainerLayer),
);

// ─── Utility ───────────────────────────────────────────────────────────────

/**
 * Quick check if Docker is available.
 * Use to conditionally skip PG test suites.
 */
export const checkDockerAvailable = (): boolean => {
  try {
    const { execSync } = require("node:child_process");
    execSync("docker info", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};
