/**
 * Backend factory for multi-backend stress tests.
 *
 * Uses DatabaseManager (the public API) to construct TripleStore and Datalog
 * services — the same path production code uses.
 *
 * Supports two backends:
 * - sqlite (default): File-based SQLite via better-sqlite3
 * - pg: PostgreSQL via @effect/sql-pg (requires DATABASE_URL)
 *
 * Usage:
 *   STRESS_BACKEND=sqlite|pg
 *   DATABASE_URL=postgresql://... (required for pg)
 */

import { Effect, Layer } from "effect";
import { NodeContext } from "@effect/platform-node";
import {
  DatabaseManager,
  DatabaseManagerLive,
  DatabaseRegistryLive,
  type TripleStoreService,
  type DatalogService,
} from "@open-ontology/core";
import { makeSqliteBackend } from "@open-ontology/core/storage/sqlite";
import { makePostgresqlBackendFromUrl } from "@open-ontology/core/storage/postgres";
import { promises as fs } from "node:fs";

// ─── Types ─────────────────────────────────────────────────────────────────

export type BackendName = "sqlite" | "pg";

export interface PerformanceThresholds {
  /** Max insertion time (ms) */
  readonly insertionTimeout: number;
  /** Min insertion throughput (triples/sec) */
  readonly minThroughput: number;
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

const SQLITE_THRESHOLDS: PerformanceThresholds = {
  insertionTimeout: 600_000,
  minThroughput: 1_000,
  entityLookup: 200,
  attributeScan: 2_000,
  typeFilter: 2_000,
  valueFilter: 200,
  refLookup: 100,
  booleanFilter: 500,
  datalogSimple: 3_000,
  datalogJoin: 5_000,
  datalogPredicate: 5_000,
  datalogMultiAttr: 3_000,
  datalogAggregation: 5_000,
  datalogRefTraversal: 5_000,
};

const PG_THRESHOLDS: PerformanceThresholds = {
  insertionTimeout: 600_000,
  minThroughput: 500,
  entityLookup: 200,
  attributeScan: 3_000,
  typeFilter: 3_000,
  valueFilter: 300,
  refLookup: 200,
  booleanFilter: 1_000,
  datalogSimple: 5_000,
  datalogJoin: 8_000,
  datalogPredicate: 8_000,
  datalogMultiAttr: 5_000,
  datalogAggregation: 8_000,
  datalogRefTraversal: 8_000,
};

// ─── Backend detection ─────────────────────────────────────────────────────

/**
 * Read the STRESS_BACKEND env var, defaulting to "sqlite".
 * Throws if an invalid value is provided.
 */
export function getBackendName(): BackendName {
  const raw = process.env["STRESS_BACKEND"] ?? "sqlite";
  const normalized = raw.toLowerCase().trim();

  if (normalized === "sqlite" || normalized === "pg") {
    return normalized;
  }

  throw new Error(`Invalid STRESS_BACKEND="${raw}". Must be one of: sqlite, pg`);
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

// ─── Layer construction ────────────────────────────────────────────────────

const STRESS_DATA_DIR = "./stress-data";
const STRESS_DB_NAME = "stress-test";

/**
 * Build the Effect Layer providing DatabaseManager for the given backend.
 *
 * The test should use `DatabaseManager.getStore(STRESS_DB_NAME)` and
 * `DatabaseManager.getDatalog(STRESS_DB_NAME)` to get TripleStore and Datalog.
 */
export function makeTestLayer(backend: BackendName): Layer.Layer<DatabaseManager> {
  switch (backend) {
    case "sqlite":
      return makeSqliteManagerLayer();
    case "pg":
      return makePgManagerLayer();
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

// ─── Database name ─────────────────────────────────────────────────────────

/**
 * The database name used by the stress test within DatabaseManager.
 */
export const STRESS_DATABASE = STRESS_DB_NAME;

// ─── Helper to get TripleStore and Datalog via DatabaseManager ─────────────

/**
 * Create the stress test database and return TripleStore + Datalog services.
 * Uses the public DatabaseManager API, the same path production code uses.
 */
export function getStoreAndDatalog(): Effect.Effect<
  { store: TripleStoreService; datalog: DatalogService },
  unknown,
  DatabaseManager
> {
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
 * Get backend-specific performance thresholds.
 */
export function getThresholds(backend: BackendName): PerformanceThresholds {
  switch (backend) {
    case "sqlite":
      return SQLITE_THRESHOLDS;
    case "pg":
      return PG_THRESHOLDS;
  }
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
  }
}

/**
 * Whether BulkInsertOptions are applicable (only for SQLite).
 */
export function supportsBulkOptions(backend: BackendName): boolean {
  return backend === "sqlite";
}
