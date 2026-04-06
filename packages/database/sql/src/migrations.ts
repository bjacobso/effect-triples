import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { MigrationError } from "@open-ontology/database";
import {
  TRIPLES_TABLE_DDL,
  MIGRATIONS_TABLE_DDL,
  INDEX_DDLS,
  ENTITY_BLOBS_TABLE_DDL,
  ENTITY_SNAPSHOTS_TABLE_DDL,
  SNAPSHOT_INDEX_DDLS,
} from "./schema.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

/**
 * Versioned migrations for the database schema.
 *
 * DDL is imported from schema.ts (single source of truth).
 * This migration system tracks which migrations have been applied.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: TRIPLES_TABLE_DDL,
  },
  {
    version: 2,
    name: "create_migrations_table",
    up: MIGRATIONS_TABLE_DDL,
  },
  {
    version: 3,
    name: "add_indexes",
    up: INDEX_DDLS[0],
  },
  {
    version: 4,
    name: "add_attribute_index",
    up: INDEX_DDLS[1],
  },
  {
    version: 5,
    name: "add_type_index",
    up: INDEX_DDLS[2],
  },
  {
    version: 6,
    name: "add_attr_string_index",
    up: INDEX_DDLS[3],
  },
  {
    version: 7,
    name: "add_attr_number_index",
    up: INDEX_DDLS[4],
  },
  {
    version: 8,
    name: "add_ref_index",
    up: INDEX_DDLS[5],
  },
  {
    version: 9,
    name: "add_temporal_index",
    up: INDEX_DDLS[6],
  },
  {
    version: 10,
    name: "add_entity_attr_index",
    up: INDEX_DDLS[7],
  },
  {
    version: 11,
    name: "add_tx_id_index",
    up: INDEX_DDLS[8],
  },
  {
    version: 12,
    name: "add_blob_value_type",
    // SQLite CHECK constraints are baked into CREATE TABLE. Existing tables
    // silently accept new values. This migration is a version marker;
    // the DDL in schema.ts already includes 'blob' for new databases.
    up: `SELECT 1`,
  },
  {
    version: 13,
    name: "add_retract_tx_id",
    up: `ALTER TABLE triples ADD COLUMN retract_tx_id TEXT`,
  },
  {
    version: 14,
    name: "create_entity_blobs",
    up: ENTITY_BLOBS_TABLE_DDL,
  },
  {
    version: 15,
    name: "create_entity_snapshots",
    up: ENTITY_SNAPSHOTS_TABLE_DDL,
  },
  {
    version: 16,
    name: "add_snapshot_entity_index",
    up: SNAPSHOT_INDEX_DDLS[0],
  },
  {
    version: 17,
    name: "add_snapshot_tx_index",
    up: SNAPSHOT_INDEX_DDLS[1],
  },
  {
    version: 18,
    name: "add_snapshot_hash_index",
    up: SNAPSHOT_INDEX_DDLS[2],
  },
  {
    version: 19,
    name: "add_snapshot_type_index",
    up: SNAPSHOT_INDEX_DDLS[3],
  },
];

export const runMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Ensure migrations table exists first
  yield* sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `;

  // Get already applied migrations
  const applied = yield* sql<{ version: number }>`
    SELECT version FROM schema_migrations ORDER BY version
  `;
  const appliedVersions = new Set(applied.map((r) => r.version));

  // Run pending migrations
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    // Execute the migration SQL (ignore "duplicate column" errors from ALTER TABLE
    // migrations on fresh databases where the DDL already includes the column)
    yield* sql.unsafe(migration.up).pipe(
      Effect.catchIf(
        (error) => {
          const msg = (
            String(error) + String((error as { cause?: unknown }).cause ?? "")
          ).toLowerCase();
          return (
            msg.includes("duplicate column name") ||
            (msg.includes("column") && msg.includes("already exists"))
          );
        },
        () => Effect.void,
      ),
      Effect.mapError(
        (error) =>
          new MigrationError({
            version: migration.version,
            name: migration.name,
            message: `Failed to run migration: ${String(error)}`,
            cause: error,
          }),
      ),
    );

    // Record migration as applied
    const now = Date.now();
    yield* sql`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (${migration.version}, ${migration.name}, ${now})
    `;
  }
});
