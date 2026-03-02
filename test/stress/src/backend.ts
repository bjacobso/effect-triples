/**
 * Backend factory for multi-backend stress tests.
 *
 * Uses DatabaseManager (the public API) to construct TripleStore and Datalog
 * services for SQL backends — the same path production code uses.
 *
 * Supports three backends:
 * - sqlite (default): File-based SQLite via better-sqlite3
 * - pg: PostgreSQL via @effect/sql-pg (requires DATABASE_URL)
 * - kv: In-memory ordered KV store with hexastore indexes
 *
 * Usage:
 *   STRESS_BACKEND=sqlite|pg|kv
 *   DATABASE_URL=postgresql://... (required for pg)
 */

import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { NodeContext } from "@effect/platform-node";
import {
  TripleStore,
  Datalog,
  DatabaseManager,
  DatabaseManagerLive,
  DatabaseRegistryLive,
  type TripleStoreService,
  type DatalogService,
} from "@open-ontology/core";
import { makeSqliteBackend } from "@open-ontology/core/storage/sqlite";
import {
  makePostgresqlBackendFromUrl,
  makePostgresqlLayerFromUrl,
} from "@open-ontology/core/storage/postgres";
import { KvTripleStoreLive, KvDatalogLive, InMemoryKvBackendLive } from "@open-ontology/core/kv";
import { promises as fs } from "node:fs";

// ─── Types ─────────────────────────────────────────────────────────────────

export type BackendName = "sqlite" | "pg" | "kv";

export interface PerformanceThresholds {
  /** Max insertion time (ms) */
  readonly insertionTimeout: number;
  /** Min insertion throughput (triples/sec) */
  readonly minThroughput: number;
  /** Max total update time per round (ms) */
  readonly updateRoundTimeout: number;
  /** Min update throughput (updates/sec) — each update = retract + assert for 1 attribute */
  readonly minUpdateThroughput: number;
  /** Q1: Single entity lookup (ms) */
  readonly entityLookup: number;
  /** Q2: Attribute scan (ms) */
  readonly attributeScan: number;
  /** Q3: Entity type filter (ms) */
  readonly typeFilter: number;
  /** Q4: Specific value filter (ms) */
  readonly valueFilter: number;
  /** Q5: Reference lookup (ms) */
  readonly refLookup: number;
  /** Q6: Boolean filter (ms) */
  readonly booleanFilter: number;
  /** D1: Simple Datalog pattern (ms) */
  readonly datalogSimple: number;
  /** D2: Two-variable join (ms) */
  readonly datalogJoin: number;
  /** D3: Predicate filter (ms) */
  readonly datalogPredicate: number;
  /** D4: Multi-attribute with value binding (ms) */
  readonly datalogMultiAttr: number;
  /** D5: Aggregation (ms) */
  readonly datalogAggregation: number;
  /** D6: Reference traversal (ms) */
  readonly datalogRefTraversal: number;
}

// ─── Configuration ─────────────────────────────────────────────────────────

// Base thresholds are for 100k employees with 0 update rounds.
// getThresholds() scales query thresholds based on actual employee count and
// update rounds, since full-table scans grow linearly with total row count
// (initial rows + retracted rows from updates).

interface BaseThresholds extends PerformanceThresholds {
  /** Backend multiplier for table-scan queries (PG is slower due to network RTT) */
  readonly scanMultiplier: number;
}

const SQLITE_BASE: BaseThresholds = {
  insertionTimeout: 600_000,
  minThroughput: 1_000,
  updateRoundTimeout: 1_200_000,
  minUpdateThroughput: 100,
  entityLookup: 200,
  // Base thresholds for 100k employees, 0 update rounds:
  attributeScan: 2_000,
  typeFilter: 2_000,
  valueFilter: 2_000,
  refLookup: 200,
  booleanFilter: 2_000,
  datalogSimple: 3_000,
  datalogJoin: 5_000,
  datalogPredicate: 5_000,
  datalogMultiAttr: 3_000,
  datalogAggregation: 5_000,
  datalogRefTraversal: 5_000,
  scanMultiplier: 1,
};

const PG_BASE: BaseThresholds = {
  insertionTimeout: 600_000,
  minThroughput: 500,
  updateRoundTimeout: 1_800_000,
  minUpdateThroughput: 50,
  entityLookup: 200,
  attributeScan: 3_000,
  typeFilter: 3_000,
  valueFilter: 3_000,
  refLookup: 200,
  booleanFilter: 3_000,
  datalogSimple: 5_000,
  datalogJoin: 8_000,
  datalogPredicate: 8_000,
  datalogMultiAttr: 5_000,
  datalogAggregation: 8_000,
  datalogRefTraversal: 8_000,
  scanMultiplier: 1.5,
};

const KV_BASE: BaseThresholds = {
  insertionTimeout: 600_000,
  minThroughput: 500,
  updateRoundTimeout: 3_600_000,
  minUpdateThroughput: 10,
  // KV uses Datom cache + sync scan path. Partitioned Maps mean sorted-key
  // rebuild only sorts ~920K keys per partition (not 5.5M). Thresholds are
  // generous to accommodate GC pauses and system load variance.
  entityLookup: 500,
  attributeScan: 2_000,
  // entityType filter uses KV TYPE index — O(k) scan, not full EAVT scan
  typeFilter: 2_000,
  valueFilter: 1_000,
  refLookup: 200,
  booleanFilter: 2_000,
  // Datalog uses hash join for multi-context patterns — O(n) scan + O(1) lookups
  datalogSimple: 2_000,
  datalogJoin: 3_000,
  datalogPredicate: 3_000,
  datalogMultiAttr: 5_000,
  datalogAggregation: 2_000,
  datalogRefTraversal: 3_000,
  scanMultiplier: 1,
};

// ─── Backend detection ─────────────────────────────────────────────────────

/**
 * Read the STRESS_BACKEND env var, defaulting to "sqlite".
 * Throws if an invalid value is provided.
 */
export function getBackendName(): BackendName {
  const raw = process.env["STRESS_BACKEND"] ?? "sqlite";
  const normalized = raw.toLowerCase().trim();

  if (normalized === "sqlite" || normalized === "pg" || normalized === "kv") {
    return normalized;
  }

  throw new Error(`Invalid STRESS_BACKEND="${raw}". Must be one of: sqlite, pg, kv`);
}

/**
 * Get the configurable employee count.
 * Default: 100,000. Override with STRESS_EMPLOYEE_COUNT env var.
 */
export function getEmployeeCount(): number {
  const raw = process.env["STRESS_EMPLOYEE_COUNT"];
  if (!raw) return 100_000;

  const count = parseInt(raw, 10);
  if (isNaN(count) || count <= 0) {
    throw new Error(`Invalid STRESS_EMPLOYEE_COUNT="${raw}". Must be a positive integer.`);
  }
  return count;
}

/**
 * Get the number of update rounds.
 * Default: 10. Override with STRESS_UPDATE_ROUNDS env var.
 * Set to 0 to skip the update phase entirely.
 */
export function getUpdateRounds(): number {
  const raw = process.env["STRESS_UPDATE_ROUNDS"];
  if (!raw) return 10;

  const rounds = parseInt(raw, 10);
  if (isNaN(rounds) || rounds < 0) {
    throw new Error(`Invalid STRESS_UPDATE_ROUNDS="${raw}". Must be a non-negative integer.`);
  }
  return rounds;
}

// ─── Layer construction ────────────────────────────────────────────────────

const STRESS_DATA_DIR = "./stress-data";
const STRESS_DB_NAME = "stress-test";

/**
 * Build the Effect Layer for the given backend.
 *
 * For sqlite/pg: provides DatabaseManager (use getStoreAndDatalog() to get services).
 * For kv: provides TripleStore + Datalog directly (use getStoreAndDatalog() which handles both).
 */
export function makeTestLayer(
  backend: BackendName,
): Layer.Layer<DatabaseManager | TripleStore | Datalog> {
  switch (backend) {
    case "sqlite":
      return makeSqliteManagerLayer() as Layer.Layer<DatabaseManager | TripleStore | Datalog>;
    case "pg":
      return makePgManagerLayer() as Layer.Layer<DatabaseManager | TripleStore | Datalog>;
    case "kv":
      return makeKvTestLayer() as Layer.Layer<DatabaseManager | TripleStore | Datalog>;
  }
}

function makeSqliteManagerLayer(): Layer.Layer<DatabaseManager> {
  const backend = makeSqliteBackend({ dataDir: STRESS_DATA_DIR });
  return DatabaseManagerLive.pipe(
    Layer.provide(DatabaseRegistryLive),
    Layer.provide(backend),
    Layer.provide(NodeContext.layer),
  ) as Layer.Layer<DatabaseManager>;
}

function makePgManagerLayer(): Layer.Layer<DatabaseManager> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "STRESS_BACKEND=pg requires DATABASE_URL environment variable.\n" +
        "Example: DATABASE_URL=postgresql://user:pass@localhost:5432/ontology_stress",
    );
  }
  const backend = makePostgresqlBackendFromUrl(url);
  return DatabaseManagerLive.pipe(
    Layer.provide(DatabaseRegistryLive),
    Layer.provide(backend),
  ) as Layer.Layer<DatabaseManager>;
}

function makeKvTestLayer() {
  const kvBackend = InMemoryKvBackendLive;
  const storeLayer = KvTripleStoreLive.pipe(Layer.provide(kvBackend));
  const datalogLayer = KvDatalogLive.pipe(Layer.provide(kvBackend));
  return Layer.mergeAll(storeLayer, datalogLayer) as unknown as Layer.Layer<
    DatabaseManager | TripleStore | Datalog
  >;
}

/**
 * Get a SqlClient layer for raw SQL access (needed by the update test).
 * Only available for sqlite/pg backends. KV has no SQL layer.
 */
export function makeSqlLayer(backend: BackendName): Layer.Layer<SqlClient.SqlClient> | null {
  switch (backend) {
    case "sqlite": {
      const dbPath = `${STRESS_DATA_DIR}/${STRESS_DB_NAME}.db`;
      return SqliteClient.layer({
        filename: dbPath,
      }) as unknown as Layer.Layer<SqlClient.SqlClient>;
    }
    case "pg": {
      const url = process.env["DATABASE_URL"];
      if (!url) return null;
      return makePostgresqlLayerFromUrl(url) as unknown as Layer.Layer<SqlClient.SqlClient>;
    }
    case "kv":
      return null;
  }
}

// ─── Database name ─────────────────────────────────────────────────────────

/**
 * The database name used by the stress test within DatabaseManager.
 */
export const STRESS_DATABASE = STRESS_DB_NAME;

// ─── Helper to get TripleStore and Datalog ─────────────────────────────────

/**
 * Get TripleStore and Datalog services.
 *
 * For sqlite/pg: uses DatabaseManager.getStore/getDatalog (the production path).
 * For kv: reads TripleStore and Datalog directly from the layer (no DatabaseManager).
 */
export function getStoreAndDatalog(): Effect.Effect<
  { store: TripleStoreService; datalog: DatalogService },
  unknown,
  DatabaseManager | TripleStore | Datalog
> {
  const backend = getBackendName();

  if (backend === "kv") {
    return Effect.gen(function* () {
      const store = yield* TripleStore;
      const datalog = yield* Datalog;
      return { store, datalog };
    });
  }

  return Effect.gen(function* () {
    const manager = yield* DatabaseManager;

    // Create database (ignore if already exists)
    yield* manager.create(STRESS_DB_NAME, "Stress test database").pipe(Effect.ignore);

    const store = yield* manager.getStore(STRESS_DB_NAME);
    const datalog = yield* manager.getDatalog(STRESS_DB_NAME);

    return { store, datalog };
  });
}

// ─── Performance thresholds ────────────────────────────────────────────────

/**
 * Get backend-specific performance thresholds, scaled by employee count and
 * update rounds.
 *
 * Full-table scan queries (Q2-Q6, D1-D6) grow linearly with total row count.
 * After N update rounds with 5 attributes per round, the triples table has:
 *   initialRows + N * employeeCount * 5 * 2  (retracted + new assertion rows)
 * Point lookups (Q1, Q5) use indexes and don't scale with total rows.
 *
 * The scaling factor is: (totalRows / baseRows) where baseRows = 100k * 10 = 1M.
 */
export function getThresholds(backend: BackendName): PerformanceThresholds {
  const base: BaseThresholds = (() => {
    switch (backend) {
      case "sqlite":
        return SQLITE_BASE;
      case "pg":
        return PG_BASE;
      case "kv":
        return KV_BASE;
    }
  })();

  const employeeCount = getEmployeeCount();
  const updateRounds = getUpdateRounds();

  // Base row count assumption: 100k employees * 10 attrs = 1M rows
  const BASE_ROWS = 100_000 * 10;
  // Actual total rows = initial + 2 * updates (each update adds retracted + new row)
  const actualRows = employeeCount * 10 + updateRounds * employeeCount * 5 * 2;
  const scaleFactor = Math.max(1, actualRows / BASE_ROWS);

  // Scale scan-dependent thresholds
  const scale = (baseMs: number) => Math.round(baseMs * scaleFactor * base.scanMultiplier);

  return {
    insertionTimeout: base.insertionTimeout * Math.max(1, employeeCount / 100_000),
    minThroughput: base.minThroughput,
    updateRoundTimeout: base.updateRoundTimeout,
    minUpdateThroughput: base.minUpdateThroughput,
    entityLookup: base.entityLookup,
    attributeScan: scale(base.attributeScan),
    typeFilter: scale(base.typeFilter),
    valueFilter: scale(base.valueFilter),
    refLookup: base.refLookup * Math.max(1, employeeCount / 100_000),
    booleanFilter: scale(base.booleanFilter),
    datalogSimple: scale(base.datalogSimple),
    datalogJoin: scale(base.datalogJoin),
    datalogPredicate: scale(base.datalogPredicate),
    datalogMultiAttr: scale(base.datalogMultiAttr),
    datalogAggregation: scale(base.datalogAggregation),
    datalogRefTraversal: scale(base.datalogRefTraversal),
  };
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

/**
 * Clean up backend resources before tests.
 */
export async function cleanupBefore(backend: BackendName): Promise<void> {
  switch (backend) {
    case "sqlite":
      // Remove the entire stress-data directory to ensure a clean state
      await fs.rm(STRESS_DATA_DIR, { force: true, recursive: true }).catch(() => {});
      break;
    case "pg":
      // PostgreSQL: migrations handle schema creation.
      // DatabaseManager.create handles schema setup on first use.
      break;
    case "kv":
      // In-memory: nothing to clean up
      break;
  }
}

/**
 * Clean up backend resources after tests.
 */
export async function cleanupAfter(backend: BackendName): Promise<void> {
  const keepDb = process.env["STRESS_TEST_KEEP_DB"] === "true";

  switch (backend) {
    case "sqlite":
      if (!keepDb) {
        await fs.rm(STRESS_DATA_DIR, { force: true, recursive: true }).catch(() => {});
        console.log(`\n  Test database cleaned up`);
      } else {
        console.log(`\n  Database preserved at: ${STRESS_DATA_DIR}/`);
        console.log(`  Inspect with: sqlite3 ${STRESS_DATA_DIR}/${STRESS_DB_NAME}.db`);
      }
      break;
    case "pg":
      if (!keepDb) {
        console.log(
          `\n  PostgreSQL: data preserved in database (use STRESS_TEST_KEEP_DB=true to silence)`,
        );
      } else {
        console.log(`\n  PostgreSQL: data preserved for inspection`);
      }
      break;
    case "kv":
      console.log(`\n  KV store: in-memory data released`);
      break;
  }
}

// ─── Reporting helpers ─────────────────────────────────────────────────────

/**
 * Get database size for reporting (backend-aware).
 */
export async function getDatabaseSize(backend: BackendName): Promise<string> {
  switch (backend) {
    case "sqlite": {
      try {
        const dbPath = `${STRESS_DATA_DIR}/${STRESS_DB_NAME}.db`;
        const stats = await fs.stat(dbPath);
        const dbSizeMB = stats.size / 1024 / 1024;
        return `${dbSizeMB.toFixed(1)} MB`;
      } catch {
        return "N/A";
      }
    }
    case "pg":
      return "N/A (use psql to check table sizes)";
    case "kv":
      return "N/A (in-memory)";
  }
}

/**
 * Human-readable backend description.
 */
export function describeBackend(backend: BackendName): string {
  switch (backend) {
    case "sqlite":
      return `SQLite (dir: ${STRESS_DATA_DIR})`;
    case "pg":
      return `PostgreSQL (${process.env["DATABASE_URL"]?.replace(/:[^@]*@/, ":***@") ?? "no url"})`;
    case "kv":
      return "KV Store (in-memory, hexastore indexes)";
  }
}

/**
 * Whether BulkInsertOptions are applicable (only for SQLite).
 */
export function supportsBulkOptions(backend: BackendName): boolean {
  return backend === "sqlite";
}
