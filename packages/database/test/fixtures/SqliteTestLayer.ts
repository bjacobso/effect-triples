/**
 * SQLite test layers with acquireRelease lifecycle management.
 *
 * Provides pre-composed Effect layers for testing with in-memory or file-based
 * SQLite. Follows the same acquireRelease pattern as FdbTestLayer and PgTestLayer.
 *
 * Exported layers:
 *
 * - `SqliteTestLayer`      — TripleStore (in-memory)
 * - `SqliteFullTestLayer`  — TripleStore + Datalog + SqlQueryExecutor (in-memory)
 * - `SqliteFileTestLayer`  — TripleStore (file-based, auto-cleanup)
 * - `SqliteFileFullTestLayer` — TripleStore + Datalog (file-based, auto-cleanup)
 *
 * Usage with @effect/vitest:
 *
 * ```ts
 * import { layer } from "@effect/vitest"
 * import { SqliteFullTestLayer } from "../fixtures/SqliteTestLayer.js"
 *
 * layer(SqliteFullTestLayer)("my tests", (it) => {
 *   it.effect("queries work", () =>
 *     Effect.gen(function* () {
 *       const store = yield* TripleStore
 *       // ...
 *     })
 *   )
 * })
 * ```
 *
 * Or for tests that compose additional service layers:
 *
 * ```ts
 * import { SqliteTestLayer } from "../fixtures/SqliteTestLayer.js"
 *
 * const TestLayer = MyServiceLive.pipe(
 *   Layer.provide(SqliteTestLayer),
 * )
 * ```
 */

import { Context, Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TripleStoreLive } from "../../src/index.js";
import { DatalogLive, SqlQueryExecutorLive } from "../../sql/src/index.js";
import { SqliteAdapterLive } from "../../sqlite/src/index.js";

// ─── Pre-composed layers (in-memory, most common) ──────────────────────────

/**
 * TripleStore backed by in-memory SQLite.
 *
 * Use when your test only needs TripleStore operations.
 */
export const SqliteTestLayer = TripleStoreLive.pipe(
  Layer.provideMerge(SqliteAdapterLive),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);

/**
 * TripleStore + Datalog + SqlQueryExecutor backed by in-memory SQLite.
 *
 * Use when your test needs both TripleStore and Datalog queries.
 */
export const SqliteFullTestLayer = DatalogLive.pipe(
  Layer.provideMerge(SqlQueryExecutorLive),
  Layer.provideMerge(TripleStoreLive),
  Layer.provideMerge(SqliteAdapterLive),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);

// ─── File-based layers (for stress tests / inspection) ─────────────────────

/**
 * Internal context tag carrying the temp directory and DB path.
 * Mirrors FdbTestLayer's FdbClusterFile pattern.
 */
class SqliteDbInfo extends Context.Tag("test/SqliteDbInfo")<
  SqliteDbInfo,
  { readonly dbPath: string; readonly tmpDir: string }
>() {}

/**
 * Scoped layer that creates a temp directory on acquire and
 * removes it on release. Provides SqliteDbInfo.
 */
const SqliteFileLifecycleLayer: Layer.Layer<SqliteDbInfo> = Layer.scoped(
  SqliteDbInfo,
  Effect.acquireRelease(
    Effect.sync(() => {
      const tmpDir = path.join(
        os.tmpdir(),
        `sqlite-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      );
      fs.mkdirSync(tmpDir, { recursive: true });
      const dbPath = path.join(tmpDir, "test.db");
      return { tmpDir, dbPath };
    }),
    ({ tmpDir }) =>
      Effect.sync(() => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }),
  ),
);

/**
 * SqliteClient layer that reads the DB path from SqliteDbInfo.
 * Uses Layer.unwrapEffect to dynamically construct the client layer.
 */
const FileSqliteClientLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const { dbPath } = yield* SqliteDbInfo;
    return SqliteClient.layer({ filename: dbPath });
  }),
);

/**
 * Composed file-based SqliteClient: lifecycle + client.
 */
const FileSqliteLayer = FileSqliteClientLayer.pipe(Layer.provide(SqliteFileLifecycleLayer));

/**
 * TripleStore backed by file-based SQLite with auto-cleanup.
 *
 * Creates a unique temp directory per layer instantiation. The directory
 * and DB file are removed when the layer scope closes.
 */
export const SqliteFileTestLayer = TripleStoreLive.pipe(
  Layer.provideMerge(SqliteAdapterLive),
  Layer.provide(FileSqliteLayer),
);

/**
 * TripleStore + Datalog backed by file-based SQLite with auto-cleanup.
 */
export const SqliteFileFullTestLayer = DatalogLive.pipe(
  Layer.provideMerge(SqlQueryExecutorLive),
  Layer.provideMerge(TripleStoreLive),
  Layer.provideMerge(SqliteAdapterLive),
  Layer.provide(FileSqliteLayer),
);
