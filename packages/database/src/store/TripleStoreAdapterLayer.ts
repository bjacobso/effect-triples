/**
 * TripleStoreAdapterLayer - TripleStore implementation using StorageAdapter
 *
 * This layer provides the TripleStore service using the StorageAdapter abstraction,
 * allowing different backends (SQLite, PostgreSQL, Cloudflare DO, etc.) to use
 * their optimal primitives.
 *
 * This is the canonical TripleStore implementation. All backends go through
 * the StorageAdapter interface.
 */

import { Effect, Layer, Option } from "effect";
import {
  TripleStore,
  type TripleStoreService,
  type TransactionResult,
  type TransactionMeta,
  type BulkInsertOptions,
} from "./TripleStore.js";
import { StorageAdapter } from "../storage/StorageAdapter.js";
import type {
  Triple,
  TripleInput,
  TripleId,
  EntityId,
  Attribute,
  TripleRow,
  TransactOp,
} from "@open-ontology/database";
import { queryToPattern } from "@open-ontology/database";
import type { Pattern } from "../types/Pattern.js";
import type { QueryState } from "../types/QueryBuilder.js";
import type { Filter, SortSpec } from "../types/Filter.js";
import { WriteError, ReadError, QueryError } from "../errors/index.js";
import type { SqlDialect } from "../dialects/index.js";
import { CurrentDialect } from "../dialects/index.js";
import { SqliteDialect } from "../dialects/sqlite.js";
import { createParamCollector, type ParamCollector } from "../params.js";
import { TxAttributes } from "../utils/id.js";
import { TripleStoreRuntime } from "./TripleStoreRuntime.js";

// =============================================================================
// Row to Triple Conversion
// =============================================================================

const rowToTriple = (row: TripleRow): Triple => {
  // Unpack value from row
  let value: Triple["value"];
  switch (row.value_type) {
    case "string":
      value = { type: "string", value: row.value_string ?? "" };
      break;
    case "number":
      value = { type: "number", value: row.value_number ?? 0 };
      break;
    case "boolean":
      value = { type: "boolean", value: row.value_boolean === 1 };
      break;
    case "datetime":
      value = { type: "datetime", value: row.value_datetime ?? 0 };
      break;
    case "ref":
      value = { type: "ref", value: row.value_string ?? "" };
      break;
    case "json":
      value = { type: "json", value: row.value_json ? JSON.parse(row.value_json) : null };
      break;
    case "blob": {
      const meta = row.value_json ? JSON.parse(row.value_json) : {};
      value = {
        type: "blob",
        value: row.value_string ?? "",
        mimeType: meta.mimeType ?? "application/octet-stream",
        size: meta.size ?? 0,
        ...(meta.filename && { filename: meta.filename }),
      };
      break;
    }
    default:
      value = { type: "string", value: "" };
  }

  return {
    id: row.id as TripleId,
    entityId: row.entity_id as EntityId,
    attribute: row.attribute as Attribute,
    value,
    createdAt: row.created_at,
    createdBy: row.created_by ? Option.some(row.created_by) : Option.none(),
    retractedAt: row.retracted_at ? Option.some(row.retracted_at) : Option.none(),
    entityType: row.entity_type ? Option.some(row.entity_type) : Option.none(),
    schemaVersion: row.schema_version ? Option.some(row.schema_version) : Option.none(),
    txId: row.tx_id ? Option.some(row.tx_id) : Option.none(),
    retractTxId: row.retract_tx_id ? Option.some(row.retract_tx_id) : Option.none(),
  };
};

// =============================================================================
// Query Builder Helpers
// =============================================================================

const getValueColumn = (value: unknown): string => {
  if (typeof value === "string") return "value_string";
  if (typeof value === "number") return "value_number";
  if (typeof value === "boolean") return "value_boolean";
  return "value_string";
};

const buildFilterCondition = (filter: Filter, alias: string, collector: ParamCollector): string => {
  const col = (name: string) => `${alias}.${name}`;
  const param = (value: unknown) => collector.add(value);

  switch (filter.type) {
    case "eq": {
      const valueCol = getValueColumn(filter.value);
      return `${col("attribute")} = ${param(filter.attribute)} AND ${col(valueCol)} = ${param(filter.value)}`;
    }
    case "neq": {
      const valueCol = getValueColumn(filter.value);
      return `${col("attribute")} = ${param(filter.attribute)} AND ${col(valueCol)} != ${param(filter.value)}`;
    }
    case "gt":
      return `${col("attribute")} = ${param(filter.attribute)} AND ${col("value_number")} > ${param(filter.value)}`;
    case "gte":
      return `${col("attribute")} = ${param(filter.attribute)} AND ${col("value_number")} >= ${param(filter.value)}`;
    case "lt":
      return `${col("attribute")} = ${param(filter.attribute)} AND ${col("value_number")} < ${param(filter.value)}`;
    case "lte":
      return `${col("attribute")} = ${param(filter.attribute)} AND ${col("value_number")} <= ${param(filter.value)}`;
    case "contains": {
      const escapedValue = collector.dialect.escapeLikePattern(filter.value);
      return `${col("attribute")} = ${param(filter.attribute)} AND ${col("value_string")} LIKE ${param(`%${escapedValue}%`)} ESCAPE '\\'`;
    }
    case "startsWith": {
      const escapedValue = collector.dialect.escapeLikePattern(filter.value);
      return `${col("attribute")} = ${param(filter.attribute)} AND ${col("value_string")} LIKE ${param(`${escapedValue}%`)} ESCAPE '\\'`;
    }
    case "in": {
      const valueCol = getValueColumn(filter.values[0]);
      const attrPlaceholder = param(filter.attribute);
      const placeholders = filter.values.map((v) => param(v)).join(", ");
      return `${col("attribute")} = ${attrPlaceholder} AND ${col(valueCol)} IN (${placeholders})`;
    }
    case "exists":
    case "notExists":
      return `1=1`; // Handled by buildExistsCondition
    case "and":
    case "or":
    case "not":
      throw new Error(`Compound filter type "${filter.type}" not yet supported`);
    default:
      throw new Error(`Unknown filter type: ${(filter as Filter).type}`);
  }
};

const buildExistsCondition = (
  filter: Filter,
  baseAlias: string,
  collector: ParamCollector,
): string | null => {
  const param = (value: unknown) => collector.add(value);

  if (filter.type === "exists") {
    return `EXISTS (SELECT 1 FROM triples WHERE entity_id = ${baseAlias}.entity_id AND attribute = ${param(filter.attribute)} AND retracted_at IS NULL)`;
  }
  if (filter.type === "notExists") {
    return `NOT EXISTS (SELECT 1 FROM triples WHERE entity_id = ${baseAlias}.entity_id AND attribute = ${param(filter.attribute)} AND retracted_at IS NULL)`;
  }
  return null;
};

const buildOrderByClause = (
  sorts: readonly SortSpec[],
  sortAliases: Map<string, string>,
): string => {
  if (sorts.length === 0) return "";

  const orderParts = sorts.map((sort) => {
    const alias = sortAliases.get(sort.attribute);
    if (!alias) return null;

    const valueCol = `${alias}.value_string`;
    const dir = sort.direction.toUpperCase();
    const nullsFirst = sort.nulls === "first";
    const nullOrder = nullsFirst ? 0 : 1;

    return `(CASE WHEN ${valueCol} IS NULL THEN ${nullOrder} ELSE ${1 - nullOrder} END), ${valueCol} ${dir}`;
  });

  const validParts = orderParts.filter((p) => p !== null);
  return validParts.length > 0 ? `ORDER BY ${validParts.join(", ")}` : "";
};

// =============================================================================
// TripleStore Layer using StorageAdapter
// =============================================================================

/**
 * TripleStore implementation using StorageAdapter.
 * This allows different backends to use their optimal primitives.
 */
export const TripleStoreLive = Layer.effect(
  TripleStore,
  Effect.gen(function* () {
    const adapter = yield* StorageAdapter;
    const runtime = yield* TripleStoreRuntime;
    const now = runtime.now;
    const nextTripleId = runtime.nextTripleId;
    const nextTxId = runtime.nextTxId;

    // Initialize storage (creates tables, indexes, etc.)
    yield* adapter.initialize();

    // =========================================================================
    // Write Operations
    // =========================================================================

    const assert_ = (input: TripleInput): Effect.Effect<Triple, WriteError> =>
      Effect.gen(function* () {
        const row = yield* adapter.insert(input, yield* nextTxId, yield* now, yield* nextTripleId);
        return rowToTriple(row);
      });

    const assertBatch = (
      inputs: readonly TripleInput[],
      _options: BulkInsertOptions = {}, // Kept for API compat, optimizations configured at adapter layer
    ): Effect.Effect<readonly Triple[], WriteError> => {
      if (inputs.length === 0) return Effect.succeed([]);

      return Effect.gen(function* () {
        const txId = yield* nextTxId;
        const timestamp = yield* now;
        const ids = yield* Effect.all(inputs.map(() => nextTripleId));

        return yield* adapter
          .batchInsert(inputs, txId, timestamp, ids)
          .pipe(Effect.map((rows) => rows.map(rowToTriple)));
      });
    };

    /**
     * Flush a batch of consecutive assert ops using adapter.batchInsert().
     * Falls back to a single adapter.insert() for batches of 1.
     */
    const flushAssertBatch = (
      assertOps: readonly TransactOp[],
      txId: string,
      timestamp: number,
    ): Effect.Effect<Triple[], WriteError> =>
      Effect.gen(function* () {
        if (assertOps.length === 0) return [];

        const inputs: TripleInput[] = assertOps.map((op) => {
          if (op.op !== "assert") throw new Error("unreachable");
          return {
            entityId: op.entityId,
            attribute: op.attribute,
            value: op.value,
            entityType: op.entityType,
          };
        });

        // Single insert — avoid batchInsert overhead
        if (inputs.length === 1) {
          const row = yield* adapter.insert(inputs[0]!, txId, timestamp, yield* nextTripleId);
          return [rowToTriple(row)];
        }

        const rows = yield* adapter.batchInsert(
          inputs,
          txId,
          timestamp,
          yield* Effect.all(inputs.map(() => nextTripleId)),
        );
        return rows.map(rowToTriple);
      });

    const transact = (
      operations: readonly TransactOp[],
      meta?: TransactionMeta,
    ): Effect.Effect<TransactionResult, WriteError | ReadError> =>
      adapter.withTransaction(
        Effect.gen(function* () {
          const txId = yield* nextTxId;
          const timestamp = yield* now;

          const triples: Triple[] = [];
          let retractedCount = 0;

          // Collect consecutive assert ops and flush them as batches
          let pendingAsserts: TransactOp[] = [];

          for (const op of operations) {
            if (op.op === "assert") {
              pendingAsserts.push(op);
              continue;
            }

            // Non-assert op: flush any pending asserts first
            if (pendingAsserts.length > 0) {
              const batch = yield* flushAssertBatch(pendingAsserts, txId, timestamp);
              triples.push(...batch);
              pendingAsserts = [];
            }

            switch (op.op) {
              case "retract": {
                yield* adapter.retract(op.id as string, timestamp, txId);
                retractedCount++;
                break;
              }
              case "retract-pattern": {
                const pattern = queryToPattern(op.pattern);
                const count = yield* retractByPattern(pattern, txId, timestamp);
                retractedCount += count;
                break;
              }
            }
          }

          // Flush any remaining asserts
          if (pendingAsserts.length > 0) {
            const batch = yield* flushAssertBatch(pendingAsserts, txId, timestamp);
            triples.push(...batch);
          }

          // Insert transaction metadata triples
          yield* adapter.insert(
            {
              entityId: txId,
              attribute: TxAttributes.INSTANT,
              value: { type: "datetime", value: timestamp },
              entityType: "_Transaction",
            },
            txId,
            timestamp,
            yield* nextTripleId,
          );

          if (meta?.user) {
            yield* adapter.insert(
              {
                entityId: txId,
                attribute: TxAttributes.USER,
                value: { type: "string", value: meta.user },
                entityType: "_Transaction",
              },
              txId,
              timestamp,
              yield* nextTripleId,
            );
          }

          return { txId, triples, retracted: retractedCount };
        }),
      );

    const retract = (
      id: TripleId,
      txId?: string,
      timestamp?: number,
    ): Effect.Effect<void, WriteError> =>
      Effect.gen(function* () {
        return yield* adapter.retract(id, timestamp ?? (yield* now), txId ?? (yield* nextTxId));
      });

    const retractByPattern = (
      pattern: Pattern,
      txId?: string,
      timestamp?: number,
    ): Effect.Effect<number, WriteError | ReadError> =>
      Effect.gen(function* () {
        const triples = yield* query(pattern);
        const resolvedTxId = txId ?? (yield* nextTxId);
        const resolvedTimestamp = timestamp ?? (yield* now);
        for (const triple of triples) {
          yield* adapter.retract(triple.id, resolvedTimestamp, resolvedTxId);
        }
        return triples.length;
      });

    // =========================================================================
    // Read Operations
    // =========================================================================

    const getTriple = (id: TripleId): Effect.Effect<Triple | null, ReadError> =>
      Effect.gen(function* () {
        const row = yield* adapter.getById(id);
        return row ? rowToTriple(row) : null;
      });

    const getEntity = (entityId: EntityId): Effect.Effect<readonly Triple[], ReadError> =>
      Effect.gen(function* () {
        const rows = yield* adapter.getByEntity(entityId);
        return rows.map(rowToTriple);
      });

    const query = (pattern: Pattern): Effect.Effect<readonly Triple[], ReadError> =>
      Effect.gen(function* () {
        const rows = yield* adapter.query(pattern);
        return rows.map(rowToTriple);
      });

    const queryAsOf = (
      pattern: Pattern,
      asOf: number,
    ): Effect.Effect<readonly Triple[], ReadError> =>
      Effect.gen(function* () {
        const rows = yield* adapter.queryAsOf(pattern, asOf);
        return rows.map(rowToTriple);
      });

    const history = (entityId: EntityId): Effect.Effect<readonly Triple[], ReadError> =>
      Effect.gen(function* () {
        const rows = yield* adapter.history(entityId);
        return rows.map(rowToTriple);
      });

    // =========================================================================
    // Query Builder Support
    // =========================================================================

    const queryWithBuilder = (
      state: QueryState,
    ): Effect.Effect<readonly Triple[], ReadError | QueryError> =>
      Effect.gen(function* () {
        // Resolve dialect from context (optional — defaults to SQLite)
        const dialectOpt = yield* Effect.serviceOption(CurrentDialect);
        const dialect: SqlDialect = dialectOpt._tag === "Some" ? dialectOpt.value : SqliteDialect;

        const collector = createParamCollector(dialect);

        // Separate filters by type
        const regularFilters = state.filters.filter(
          (f) => f.type !== "exists" && f.type !== "notExists",
        );
        const existenceFilters = state.filters.filter(
          (f) => f.type === "exists" || f.type === "notExists",
        );

        const joins: string[] = [];
        const whereConditions: string[] = [];

        // Build sort aliases and LEFT JOINs
        const sortAliases = new Map<string, string>();
        state.sorts.forEach((sort, idx) => {
          const alias = `s${idx + 1}`;
          sortAliases.set(sort.attribute, alias);
          joins.push(
            `LEFT JOIN triples ${alias} ON t0.entity_id = ${alias}.entity_id AND ${alias}.retracted_at IS NULL AND ${alias}.attribute = ${collector.add(sort.attribute)}`,
          );
        });

        // Base conditions
        whereConditions.push(`t0.entity_type = ${collector.add(state.entityType)}`);
        whereConditions.push(`t0.retracted_at IS NULL`);

        // Add JOINs for regular filters
        regularFilters.forEach((filter, idx) => {
          const alias = `f${idx + 1}`;
          joins.push(
            `JOIN triples ${alias} ON t0.entity_id = ${alias}.entity_id AND ${alias}.retracted_at IS NULL`,
          );
          whereConditions.push(buildFilterCondition(filter, alias, collector));
        });

        // Add EXISTS/NOT EXISTS conditions
        existenceFilters.forEach((filter) => {
          const condition = buildExistsCondition(filter, "t0", collector);
          if (condition) {
            whereConditions.push(condition);
          }
        });

        const orderByClause = buildOrderByClause(state.sorts, sortAliases);
        const limitOffsetClause = dialect.limitOffset(state.limit, state.offset);

        // Build entity ID query
        const entityIdSql = `
          SELECT DISTINCT t0.entity_id
          FROM triples t0
          ${joins.join("\n")}
          WHERE ${whereConditions.join(" AND ")}
          ${orderByClause}
          ${limitOffsetClause}
        `.trim();

        const entityIdRows = yield* adapter
          .rawQuery<{ entity_id: string }>(entityIdSql, [...collector.params])
          .pipe(
            Effect.mapError(
              (error) =>
                new QueryError({
                  message: `Failed to query entity IDs: ${String(error)}`,
                  sql: entityIdSql,
                  cause: error,
                }),
            ),
          );

        if (entityIdRows.length === 0) {
          return [];
        }

        // Create entity ID order map
        const entityIdOrder = new Map<string, number>();
        entityIdRows.forEach((r, idx) => {
          entityIdOrder.set(r.entity_id, idx);
        });

        // Fetch all triples for matching entity IDs
        const triplesCollector = createParamCollector(dialect);
        const placeholders = entityIdRows.map((r) => triplesCollector.add(r.entity_id)).join(", ");
        const triplesSql = `
          SELECT * FROM triples
          WHERE entity_id IN (${placeholders}) AND retracted_at IS NULL
        `.trim();

        const tripleRows = yield* adapter
          .rawQuery<TripleRow>(triplesSql, [...triplesCollector.params])
          .pipe(
            Effect.mapError(
              (error) =>
                new ReadError({
                  message: `Failed to fetch triples: ${String(error)}`,
                  cause: error,
                }),
            ),
          );

        // Convert and sort by original order
        const triples = tripleRows.map(rowToTriple);
        triples.sort((a, b) => {
          const orderA = entityIdOrder.get(a.entityId) ?? 0;
          const orderB = entityIdOrder.get(b.entityId) ?? 0;
          return orderA - orderB;
        });

        return triples;
      });

    // =========================================================================
    // Return Service
    // =========================================================================

    const withTransaction = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | WriteError> =>
      adapter.withTransaction(effect);

    return {
      assert: assert_,
      assertBatch,
      retract,
      retractByPattern,
      transact,
      getTriple,
      getEntity,
      query,
      queryAsOf,
      history,
      queryWithBuilder,
      withTransaction,
    } satisfies TripleStoreService;
  }),
);

/**
 * @deprecated Use `TripleStoreLive` instead. This alias is kept for backward compatibility.
 */
export const TripleStoreAdapterLive = TripleStoreLive;
