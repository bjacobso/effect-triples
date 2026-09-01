/**
 * PostgreSQL Storage Backend
 *
 * Uses a single PostgreSQL database with schema-per-database isolation.
 * Each database gets its own PostgreSQL schema (e.g., "db_demo_hr").
 * The registry uses the "public" schema.
 */

import { Context, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { PgClient } from "@effect/sql-pg";
import { type SqlDialect } from "@bjacobso/triplex/internal";
import { StorageBackend, type StorageBackendService } from "@bjacobso/triplex-sql";
import { PostgresqlDialect } from "./dialect.js";
import { PostgresqlAdapterLive } from "./PostgresqlAdapter.js";

// =============================================================================
// Configuration
// =============================================================================

export interface PostgresqlBackendConfig {
  readonly host?: string;
  readonly port?: number;
  readonly database: string;
  readonly username?: string;
  readonly password?: Redacted.Redacted<string>;
  readonly ssl?: boolean;
  readonly pool?: {
    readonly min?: number;
    readonly max?: number;
    readonly idleTimeout?: number;
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert database name to PostgreSQL schema name.
 * Prefixes with "db_" to avoid conflicts with reserved names.
 */
const databaseToSchema = (database: string): string => `db_${database.replace(/-/g, "_")}`;

/**
 * Create the base PgClient layer from config
 */
const createBaseLayer = (config: PostgresqlBackendConfig) =>
  PgClient.layer({
    ...(config.host && { host: config.host }),
    ...(config.port && { port: config.port }),
    database: config.database,
    ...(config.username && { username: config.username }),
    ...(config.password && { password: config.password }),
    ...(config.ssl !== undefined && { ssl: config.ssl }),
    ...(config.pool?.min !== undefined && { minConnections: config.pool.min }),
    ...(config.pool?.max !== undefined && { maxConnections: config.pool.max }),
    ...(config.pool?.idleTimeout !== undefined && { idleTimeout: config.pool.idleTimeout }),
  });

/**
 * A session-local setting such as `search_path` cannot safely be installed on
 * an Effect SQL pool: setup may run on a different connection from a later
 * query. Database-scoped services therefore own one managed PostgreSQL client.
 * Administrative operations can continue to use the pool above because their
 * SQL is schema-qualified or does not rely on session state.
 */
const createSessionLayer = (config: PostgresqlBackendConfig) =>
  PgClient.layerFrom(
    PgClient.makeClient({
      ...(config.host && { host: config.host }),
      ...(config.port && { port: config.port }),
      database: config.database,
      ...(config.username && { username: config.username }),
      ...(config.password && { password: config.password }),
      ...(config.ssl !== undefined && { ssl: config.ssl }),
    }),
  );

const createSchemaLayer = (config: PostgresqlBackendConfig, schema: string) =>
  createSessionLayer(config).pipe(
    Layer.tap((ctx) =>
      Effect.gen(function* () {
        const sql = Context.get(ctx, SqlClient.SqlClient);
        yield* sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
        yield* sql.unsafe(`SET search_path TO ${schema}`);
      }),
    ),
  );

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a PostgreSQL storage backend layer.
 *
 * @example
 * ```typescript
 * const backend = makePostgresqlBackend({
 *   host: "localhost",
 *   database: "ontology",
 *   username: "app",
 *   password: Redacted.make("secret")
 * })
 *
 * const app = DatabaseManagerLive.pipe(
 *   Layer.provide(backend)
 * )
 * ```
 */
export const makePostgresqlBackend = (
  config: PostgresqlBackendConfig,
): Layer.Layer<StorageBackend> =>
  Layer.succeed(StorageBackend, {
    dialect: PostgresqlDialect as SqlDialect,

    createDatabaseClient: (database: string) => {
      const schema = databaseToSchema(database);
      return createSchemaLayer(config, schema);
    },

    createAdapterLayer: (database: string) => {
      const schema = databaseToSchema(database);
      const sqlLayer = createSchemaLayer(config, schema);
      return PostgresqlAdapterLive.pipe(Layer.provide(sqlLayer));
    },

    createRegistryClient: () => {
      // Registry also owns a single session so its search path cannot leak or
      // disappear as pooled connections are checked out.
      return createSessionLayer(config).pipe(
        Layer.tap((ctx) =>
          Effect.gen(function* () {
            const sql = Context.get(ctx, SqlClient.SqlClient);
            yield* sql.unsafe(`SET search_path TO public`);
          }),
        ),
      );
    },

    deleteDatabaseStorage: (database: string) =>
      Effect.gen(function* () {
        const schema = databaseToSchema(database);
        // Need a client to delete - use scoped execution
        const layer = createBaseLayer(config);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          }).pipe(Effect.provide(layer)),
        );
      }),

    deleteAllStorage: () =>
      Effect.gen(function* () {
        const layer = createBaseLayer(config);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // Get all schemas that start with "db_" (our database schemas)
            const schemas = yield* sql<{ schema_name: string }>`
              SELECT schema_name
              FROM information_schema.schemata
              WHERE schema_name LIKE 'db_%'
            `;
            // Drop each schema
            for (const { schema_name } of schemas) {
              yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${schema_name} CASCADE`);
            }
            // Also clear the registry table in public schema
            yield* sql.unsafe(`DROP TABLE IF EXISTS public.databases`);
          }).pipe(Effect.provide(layer)),
        );
      }),

    getDatabaseSize: (database: string) =>
      Effect.gen(function* () {
        const schema = databaseToSchema(database);
        const layer = createBaseLayer(config);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // Get total size of all tables in the schema
            const result = yield* sql<{ total_bytes: bigint }>`
              SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) AS total_bytes
              FROM pg_tables
              WHERE schemaname = ${schema}
            `;
            const row = result[0];
            return row ? Number(row.total_bytes) : 0;
          }).pipe(Effect.provide(layer)),
        );
      }),

    describe: () =>
      `PostgreSQL (${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database})`,
  } satisfies StorageBackendService);

/**
 * Create PostgreSQL backend from a connection URL.
 *
 * @example
 * ```typescript
 * const backend = makePostgresqlBackendFromUrl(
 *   "postgresql://user:pass@localhost:5432/ontology"
 * )
 * ```
 */
export const makePostgresqlBackendFromUrl = (url: string): Layer.Layer<StorageBackend> => {
  const parsed = new URL(url);

  return makePostgresqlBackend({
    database: parsed.pathname.slice(1),
    ...(parsed.hostname && { host: parsed.hostname }),
    ...(parsed.port && { port: parseInt(parsed.port, 10) }),
    ...(parsed.username && { username: parsed.username }),
    ...(parsed.password && { password: Redacted.make(parsed.password) }),
    ssl: parsed.searchParams.get("ssl") === "true",
  });
};
