import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { runMigrations } from "@open-ontology/database";

// Create SQLite layer with WAL mode for better concurrent read performance
export const makeSqliteLayer = (filename: string) =>
  SqliteClient.layer({ filename }).pipe(
    Layer.tap(() =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Enable WAL mode for concurrent reads
        yield* sql`PRAGMA journal_mode = WAL`;
        // Normal sync is safe with WAL and faster
        yield* sql`PRAGMA synchronous = NORMAL`;
        // 64MB cache
        yield* sql`PRAGMA cache_size = -64000`;
        // Store temp tables in memory
        yield* sql`PRAGMA temp_store = MEMORY`;
        // Run migrations
        yield* runMigrations;
      }),
    ),
  );

// In-memory SQLite for testing
export const SqliteTestLayer = SqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.tap(() => runMigrations),
);

// Production layer factory
export const SqliteLive = (filename: string) => makeSqliteLayer(filename);
