/**
 * CloudflareAdapter - Cloudflare Durable Object implementation of StorageAdapter
 *
 * Uses Cloudflare's native storage.transactionSync() for atomic transactions
 * and storage.sql for raw SQL execution.
 *
 * This adapter provides optimal performance on Cloudflare by:
 * - Using native DO transactions (not SQL BEGIN/COMMIT)
 * - Using storage.sql.exec() for raw SQL operations
 * - Batching inserts within transactions for atomicity
 */

import { Effect, Layer } from "effect";
import {
  StorageAdapter,
  type StorageAdapterService,
  packValue,
  WriteError,
  ReadError,
  MigrationError,
  TRIPLES_TABLE_DDL,
  MIGRATIONS_TABLE_DDL,
  INDEX_DDLS,
  migrations,
} from "../adapter-support.js";
import type { TripleRow } from "effect-triples";

// =============================================================================
// Durable Object Types
// =============================================================================

// Cloudflare DO SQLite value types
type SqlStorageValue = string | number | ArrayBuffer | null;

// Cloudflare DO SQLite returns a cursor from exec
interface SqlStorageCursor<T> extends Iterable<T> {
  toArray(): T[];
  one(): T | null;
  raw<R extends SqlStorageValue[]>(): IterableIterator<R>;
  columnNames: string[];
  rowsRead: number;
  rowsWritten: number;
}

interface SqlStorage {
  exec<T = Record<string, SqlStorageValue>>(
    query: string,
    ...params: SqlStorageValue[]
  ): SqlStorageCursor<T>;
}

/**
 * Interface for Durable Object state with storage and SQL access.
 * This matches the relevant parts of DurableObjectState from cloudflare:workers.
 */
export interface DOState {
  readonly storage: {
    readonly sql: SqlStorage;
    transactionSync<T>(closure: () => T): T;
  };
}

// =============================================================================
// Cloudflare Adapter Factory
// =============================================================================

/**
 * Create a CloudflareAdapter service from a Durable Object state.
 *
 * This factory function creates a StorageAdapterService that uses Cloudflare's
 * native DO APIs for optimal performance.
 *
 * @param ctx - The DurableObjectState from the DO's constructor
 * @returns StorageAdapterService implementation
 */
export function makeCloudflareAdapter(ctx: DOState): StorageAdapterService {
  const sqlStorage = ctx.storage.sql;

  // Helper to convert cursor to array
  const cursorToArray = <T>(cursor: SqlStorageCursor<T>): T[] => {
    const results: T[] = [];
    for (const row of cursor) {
      results.push(row);
    }
    return results;
  };

  // =========================================================================
  // Transaction Support
  // =========================================================================

  /**
   * Execute operations within a transaction.
   *
   * IMPORTANT: Uses Cloudflare's native transactionSync which requires
   * synchronous execution. The effect parameter MUST be synchronous -
   * any async operations (network calls, timers) will cause failures.
   *
   * This is safe for DO SQLite operations which are all synchronous.
   *
   * @param effect - The effect to execute within the transaction. MUST be synchronous.
   */
  const withTransaction: StorageAdapterService["withTransaction"] = (effect) =>
    Effect.try({
      try: () => {
        // Use Cloudflare's native transactionSync for atomicity
        return ctx.storage.transactionSync(() => {
          // Run the effect synchronously within the transaction
          return Effect.runSync(effect);
        });
      },
      catch: (error) =>
        new WriteError({
          message: `Transaction failed: ${String(error)}`,
          cause: error,
        }),
    });

  // =========================================================================
  // Write Operations
  // =========================================================================

  const insert: StorageAdapterService["insert"] = (input, txId, timestamp, id) =>
    Effect.try({
      try: () => {
        const packed = packValue(input.value);

        sqlStorage.exec(
          `INSERT INTO triples (
            id, entity_id, attribute, value_type,
            value_string, value_number, value_boolean, value_datetime, value_json,
            created_at, created_by, entity_type, schema_version, tx_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.entityId,
          input.attribute,
          packed.value_type,
          packed.value_string,
          packed.value_number,
          packed.value_boolean,
          packed.value_datetime,
          packed.value_json,
          timestamp,
          input.createdBy ?? null,
          input.entityType ?? null,
          1, // schema_version
          txId,
        );

        return {
          id,
          entity_id: input.entityId,
          attribute: input.attribute,
          value_type: packed.value_type,
          value_string: packed.value_string,
          value_number: packed.value_number,
          value_boolean: packed.value_boolean,
          value_datetime: packed.value_datetime,
          value_json: packed.value_json,
          created_at: timestamp,
          created_by: input.createdBy ?? null,
          retracted_at: null,
          entity_type: input.entityType ?? null,
          schema_version: 1,
          tx_id: txId,
        } as TripleRow;
      },
      catch: (error) =>
        new WriteError({
          message: `Failed to insert triple: ${String(error)}`,
          cause: error,
        }),
    });

  const batchInsert: StorageAdapterService["batchInsert"] = (inputs, txId, timestamp, ids) => {
    if (inputs.length === 0) return Effect.succeed([]);
    if (ids.length !== inputs.length) {
      return Effect.fail(
        new WriteError({
          message: `Expected ${inputs.length} triple IDs for batch insert, got ${ids.length}`,
        }),
      );
    }

    return Effect.try({
      try: () => {
        // Use Cloudflare's native transactionSync for atomicity
        return ctx.storage.transactionSync(() => {
          const results: TripleRow[] = [];

          for (let index = 0; index < inputs.length; index++) {
            const input = inputs[index]!;
            const id = ids[index]!;
            const packed = packValue(input.value);

            sqlStorage.exec(
              `INSERT INTO triples (
                id, entity_id, attribute, value_type,
                value_string, value_number, value_boolean, value_datetime, value_json,
                created_at, created_by, entity_type, schema_version, tx_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              id,
              input.entityId,
              input.attribute,
              packed.value_type,
              packed.value_string,
              packed.value_number,
              packed.value_boolean,
              packed.value_datetime,
              packed.value_json,
              timestamp,
              input.createdBy ?? null,
              input.entityType ?? null,
              1,
              txId,
            );

            results.push({
              id,
              entity_id: input.entityId,
              attribute: input.attribute,
              value_type: packed.value_type,
              value_string: packed.value_string,
              value_number: packed.value_number,
              value_boolean: packed.value_boolean,
              value_datetime: packed.value_datetime,
              value_json: packed.value_json,
              created_at: timestamp,
              created_by: input.createdBy ?? null,
              retracted_at: null,
              entity_type: input.entityType ?? null,
              schema_version: 1,
              tx_id: txId,
            } as TripleRow);
          }

          return results;
        });
      },
      catch: (error) =>
        new WriteError({
          message: `Batch insert failed: ${String(error)}`,
          cause: error,
        }),
    });
  };

  const retract: StorageAdapterService["retract"] = (id, timestamp, txId) =>
    Effect.try({
      try: () => {
        sqlStorage.exec(
          `UPDATE triples SET retracted_at = ?, retract_tx_id = ? WHERE id = ? AND retracted_at IS NULL`,
          timestamp,
          txId ?? null,
          id,
        );
      },
      catch: (error) =>
        new WriteError({
          message: `Failed to retract triple: ${String(error)}`,
          cause: error,
        }),
    });

  // =========================================================================
  // Read Operations
  // =========================================================================

  const getById: StorageAdapterService["getById"] = (id) =>
    Effect.try({
      try: () => {
        const cursor = sqlStorage.exec<TripleRow>(
          `SELECT * FROM triples WHERE id = ? AND retracted_at IS NULL`,
          id,
        );
        const rows = cursorToArray(cursor);
        return rows.length > 0 ? rows[0]! : null;
      },
      catch: (error) =>
        new ReadError({
          message: `Failed to get triple: ${String(error)}`,
          cause: error,
        }),
    });

  const getByEntity: StorageAdapterService["getByEntity"] = (entityId) =>
    Effect.try({
      try: () => {
        const cursor = sqlStorage.exec<TripleRow>(
          `SELECT * FROM triples WHERE entity_id = ? AND retracted_at IS NULL`,
          entityId,
        );
        return cursorToArray(cursor);
      },
      catch: (error) =>
        new ReadError({
          message: `Failed to get entity: ${String(error)}`,
          cause: error,
        }),
    });

  const query: StorageAdapterService["query"] = (pattern) =>
    Effect.try({
      try: () => {
        // Build dynamic query based on pattern
        const conditions: string[] = ["retracted_at IS NULL"];
        const params: SqlStorageValue[] = [];

        if (typeof pattern.entityId === "string") {
          conditions.push(`entity_id = ?`);
          params.push(pattern.entityId);
        }

        if (typeof pattern.attribute === "string") {
          conditions.push(`attribute = ?`);
          params.push(pattern.attribute);
        }

        if (pattern.entityType) {
          conditions.push(`entity_type = ?`);
          params.push(pattern.entityType);
        }

        if (pattern.value && "type" in pattern.value) {
          const packed = packValue(pattern.value);
          conditions.push(`value_type = ?`);
          params.push(packed.value_type);

          switch (packed.value_type) {
            case "string":
            case "ref":
              conditions.push(`value_string = ?`);
              params.push(packed.value_string);
              break;
            case "number":
              conditions.push(`value_number = ?`);
              params.push(packed.value_number);
              break;
            case "boolean":
              conditions.push(`value_boolean = ?`);
              params.push(packed.value_boolean);
              break;
            case "datetime":
              conditions.push(`value_datetime = ?`);
              params.push(packed.value_datetime);
              break;
          }
        }

        const whereClause = conditions.join(" AND ");
        const cursor = sqlStorage.exec<TripleRow>(
          `SELECT * FROM triples WHERE ${whereClause}`,
          ...params,
        );
        return cursorToArray(cursor);
      },
      catch: (error) =>
        new ReadError({
          message: `Failed to query triples: ${String(error)}`,
          cause: error,
        }),
    });

  const queryAsOf: StorageAdapterService["queryAsOf"] = (pattern, asOf) =>
    Effect.try({
      try: () => {
        const conditions: string[] = [
          `created_at <= ?`,
          `(retracted_at IS NULL OR retracted_at > ?)`,
        ];
        const params: SqlStorageValue[] = [asOf, asOf];

        if (typeof pattern.entityId === "string") {
          conditions.push(`entity_id = ?`);
          params.push(pattern.entityId);
        }

        if (typeof pattern.attribute === "string") {
          conditions.push(`attribute = ?`);
          params.push(pattern.attribute);
        }

        if (pattern.entityType) {
          conditions.push(`entity_type = ?`);
          params.push(pattern.entityType);
        }

        const whereClause = conditions.join(" AND ");
        const cursor = sqlStorage.exec<TripleRow>(
          `SELECT * FROM triples WHERE ${whereClause}`,
          ...params,
        );
        return cursorToArray(cursor);
      },
      catch: (error) =>
        new ReadError({
          message: `Failed to query triples as of: ${String(error)}`,
          cause: error,
        }),
    });

  const history: StorageAdapterService["history"] = (entityId) =>
    Effect.try({
      try: () => {
        const cursor = sqlStorage.exec<TripleRow>(
          `SELECT * FROM triples WHERE entity_id = ? ORDER BY created_at ASC`,
          entityId,
        );
        return cursorToArray(cursor);
      },
      catch: (error) =>
        new ReadError({
          message: `Failed to get history: ${String(error)}`,
          cause: error,
        }),
    });

  const rawQuery = <T extends object>(sqlString: string, params: readonly unknown[]) =>
    Effect.try({
      try: () => {
        const cursor = sqlStorage.exec<T>(sqlString, ...(params as SqlStorageValue[]));
        return cursorToArray(cursor);
      },
      catch: (error) =>
        new ReadError({
          message: `Raw query failed: ${String(error)}`,
          cause: error,
        }),
    });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  const initialize: StorageAdapterService["initialize"] = () =>
    Effect.try({
      try: () => {
        // Ensure base tables exist using the local Cloudflare database schema support
        sqlStorage.exec(TRIPLES_TABLE_DDL);
        sqlStorage.exec(MIGRATIONS_TABLE_DDL);

        // Run versioned migrations (same migration list as Node.js)
        const applied = new Set<number>();
        const rows = sqlStorage
          .exec<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")
          .toArray();
        for (const row of rows) {
          applied.add(row.version);
        }

        for (const migration of migrations) {
          if (applied.has(migration.version)) continue;
          try {
            sqlStorage.exec(migration.up);
          } catch (e) {
            // Ignore "duplicate column" errors from ALTER TABLE migrations
            // on fresh databases where the DDL already includes the column
            if (!String(e).includes("duplicate column name")) throw e;
          }
          sqlStorage.exec(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
            migration.version,
            migration.name,
            Date.now(),
          );
        }

        // Create indexes using the local Cloudflare database schema support
        for (const indexDef of INDEX_DDLS) {
          sqlStorage.exec(indexDef);
        }
      },
      catch: (error) =>
        new MigrationError({
          version: 0,
          name: "cloudflare_init",
          message: `Failed to initialize storage: ${String(error)}`,
          cause: error,
        }),
    });

  const close: StorageAdapterService["close"] = () => Effect.void;

  // =========================================================================
  // Return Service
  // =========================================================================

  return {
    withTransaction,
    insert,
    batchInsert,
    retract,
    getById,
    getByEntity,
    query,
    queryAsOf,
    history,
    rawQuery,
    initialize,
    close,
  };
}

// =============================================================================
// Layer Factory
// =============================================================================

/**
 * Create a StorageAdapter Layer from a Durable Object state.
 *
 * Usage in a Durable Object:
 * ```typescript
 * const adapterLayer = makeCloudflareAdapterLayer(ctx);
 * const triplesLayer = TriplesLive.pipe(Layer.provide(adapterLayer));
 * ```
 */
export const makeCloudflareAdapterLayer = (ctx: DOState) =>
  Layer.succeed(StorageAdapter, makeCloudflareAdapter(ctx));
