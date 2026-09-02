import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { MigrationError } from "@bjacobso/triplex/internal";
import {
  TRIPLES_TABLE_DDL,
  INDEX_DDLS,
  ENTITY_BLOBS_TABLE_DDL,
  ENTITY_SNAPSHOTS_TABLE_DDL,
  SNAPSHOT_INDEX_DDLS,
  COMMIT_POSITION_TABLE_DDL,
} from "./schema.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: ReadonlyArray<string>;
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
    name: "triplex_baseline",
    up: [
      TRIPLES_TABLE_DDL,
      ...INDEX_DDLS,
      ENTITY_BLOBS_TABLE_DDL,
      ENTITY_SNAPSHOTS_TABLE_DDL,
      ...SNAPSHOT_INDEX_DDLS,
      COMMIT_POSITION_TABLE_DDL,
    ],
  },
  {
    version: 2,
    name: "bitemporal_facts",
    up: [
      "ALTER TABLE triples ADD COLUMN recorded_at BIGINT",
      "ALTER TABLE triples ADD COLUMN recorded_retracted_at BIGINT",
      "ALTER TABLE triples ADD COLUMN valid_from BIGINT",
      "ALTER TABLE triples ADD COLUMN valid_to BIGINT",
      "UPDATE triples SET recorded_at = created_at WHERE recorded_at IS NULL",
      "UPDATE triples SET recorded_retracted_at = retracted_at WHERE recorded_retracted_at IS NULL AND retracted_at IS NOT NULL",
      "UPDATE triples SET valid_from = created_at WHERE valid_from IS NULL",
      "CREATE INDEX IF NOT EXISTS idx_bitemporal ON triples(recorded_at, recorded_retracted_at, valid_from, valid_to)",
    ],
  },
  {
    version: 3,
    name: "snapshot_source_position",
    up: [
      "ALTER TABLE entity_snapshots ADD COLUMN tx_position BIGINT",
      `UPDATE entity_snapshots
       SET tx_position = (
         SELECT value_number
         FROM triples
         WHERE triples.entity_id = entity_snapshots.tx_id
           AND triples.attribute = ':_tx/position'
         ORDER BY triples.recorded_at DESC
         LIMIT 1
       )
       WHERE tx_position IS NULL`,
      "CREATE INDEX IF NOT EXISTS idx_snapshot_position ON entity_snapshots(entity_id, tx_position DESC, tx_time DESC)",
    ],
  },
];

export const runMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Ensure migrations table exists first
  yield* sql`
    CREATE TABLE IF NOT EXISTS triplex_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `;

  // Get already applied migrations
  const applied = yield* sql<{ version: number }>`
    SELECT version FROM triplex_schema_migrations ORDER BY version
  `;
  const appliedVersions = new Set(applied.map((r) => r.version));

  // Run pending migrations
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    for (const statement of migration.up) {
      yield* sql.unsafe(statement).pipe(
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
    }

    // Record migration as applied
    const now = Date.now();
    yield* sql`
      INSERT INTO triplex_schema_migrations (version, name, applied_at)
      VALUES (${migration.version}, ${migration.name}, ${now})
    `;
  }
});
