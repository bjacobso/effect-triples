/**
 * TriplesLive — the canonical `Triples` implementation over `StorageAdapter`
 * plus `QueryExecutor`.
 *
 * Writes and triple-level reads go through the `StorageAdapter` abstraction so
 * every SQL backend (SQLite, PostgreSQL, Cloudflare DO, …) can use its optimal
 * primitives. Datalog reads go through the `QueryExecutor` SPI (compiles
 * Datalog → SQL for SQL backends).
 *
 * The same service owns storage mutations and query execution.
 */

import { Effect, Layer, Option } from "effect";
import {
  Triples,
  type TriplesService,
  type TransactionResult,
  type TransactionMeta,
  type BulkInsertOptions,
  type QueryOptions,
} from "./Triples.js";
import { StorageAdapter } from "../storage/StorageAdapter.js";
import { QueryExecutor } from "../storage/QueryExecutor.js";
import type {
  Triple,
  TripleInput,
  TripleId,
  EntityId,
  Attribute,
  TripleRow,
  TransactOp,
} from "../Triple.js";
import { queryToPattern } from "../Triple.js";
import type { Pattern } from "../types/Pattern.js";
import type { QueryState } from "../types/QueryBuilder.js";
import type { Filter, SortSpec } from "../types/Filter.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import {
  WriteError,
  ReadError,
  QueryError,
  DatalogError,
  TransactionConflictError,
  PaginationCursorError,
} from "../errors/index.js";
import type { SqlDialect } from "../dialects/index.js";
import { CurrentDialect } from "../dialects/index.js";
import { SqliteDialect } from "../dialects/sqlite.js";
import { createParamCollector, type ParamCollector } from "../params.js";
import { TripleStoreRuntime } from "./TripleStoreRuntime.js";
import {
  livePreconditionIds,
  metadataInputs,
  transactionRecordFromTriples,
  transactionRecordsFromTriples,
  transactionChangeFromTriple,
  validatePreconditions,
} from "./transactionMetadata.js";
import {
  isSystemWriteAuthorized,
  reservedAssertError,
  reservedWriteError,
} from "./systemNamespace.js";
import { basisFromAsOf, resolveTemporalBasis } from "../Temporal.js";
import { TxAttributes } from "../utils/id.js";
import { finishPagination, preparePagination } from "../Pagination.js";

// =============================================================================
// Row to Triple Conversion
// =============================================================================

const rowToTriple = (row: TripleRow): Triple => {
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
    createdAt: Number(row.created_at),
    recordedAt: Number(row.recorded_at),
    validFrom: Number(row.valid_from),
    validTo: row.valid_to !== null ? Option.some(Number(row.valid_to)) : Option.none(),
    createdBy: row.created_by ? Option.some(row.created_by) : Option.none(),
    retractedAt: row.retracted_at ? Option.some(Number(row.retracted_at)) : Option.none(),
    recordedRetractedAt:
      row.recorded_retracted_at !== null
        ? Option.some(Number(row.recorded_retracted_at))
        : Option.none(),
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

const buildMatchedEntitySort = (
  sorts: readonly SortSpec[],
  sortAliases: Map<string, string>,
): {
  readonly selectClause: string;
  readonly orderBy: string;
} => {
  if (sorts.length === 0) {
    return { selectClause: "", orderBy: "entity_id ASC" };
  }

  const selections: string[] = [];
  const orderParts: string[] = [];

  sorts.forEach((sort, idx) => {
    const alias = sortAliases.get(sort.attribute);
    if (!alias) return;

    const sortAlias = `sort_${idx + 1}`;
    const aggregate = sort.direction === "desc" ? "MAX" : "MIN";
    const dir = sort.direction.toUpperCase();
    const nullsFirst = sort.nulls === "first";
    const nullOrder = nullsFirst ? 0 : 1;

    selections.push(`${aggregate}(${alias}.value_string) AS ${sortAlias}`);
    orderParts.push(`(CASE WHEN ${sortAlias} IS NULL THEN ${nullOrder} ELSE ${1 - nullOrder} END)`);
    orderParts.push(`${sortAlias} ${dir}`);
  });

  if (orderParts.length === 0) {
    return { selectClause: "", orderBy: "entity_id ASC" };
  }

  orderParts.push("entity_id ASC");

  return {
    selectClause: `, ${selections.join(", ")}`,
    orderBy: orderParts.join(", "),
  };
};

// =============================================================================
// Triples Layer using StorageAdapter + QueryExecutor
// =============================================================================

export const TriplesLive = Layer.effect(
  Triples,
  Effect.gen(function* () {
    const adapter = yield* StorageAdapter;
    const executor = yield* QueryExecutor;
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
      transact([
        {
          op: "assert",
          entityId: input.entityId,
          attribute: input.attribute,
          value: input.value,
          entityType: input.entityType,
          createdBy: input.createdBy,
          validFrom: input.validFrom,
          validTo: input.validTo,
        },
      ]).pipe(
        Effect.map((result) => result.triples[0]!),
        Effect.mapError((cause) =>
          cause instanceof WriteError
            ? cause
            : new WriteError({ message: "Failed to assert triple", cause }),
        ),
      );

    const assertBatch = (
      inputs: readonly TripleInput[],
      _options: BulkInsertOptions = {}, // Kept for API compat, optimizations configured at adapter layer
    ): Effect.Effect<readonly Triple[], WriteError> => {
      if (inputs.length === 0) return Effect.succeed([]);

      return transact(
        inputs.map((input) => ({
          op: "assert" as const,
          entityId: input.entityId,
          attribute: input.attribute,
          value: input.value,
          entityType: input.entityType,
          createdBy: input.createdBy,
          validFrom: input.validFrom,
          validTo: input.validTo,
        })),
      ).pipe(
        Effect.map((result) => result.triples),
        Effect.mapError((cause) =>
          cause instanceof WriteError
            ? cause
            : new WriteError({ message: "Failed to assert triple batch", cause }),
        ),
      );
    };

    /**
     * Flush a batch of consecutive assert ops using adapter.batchInsert().
     * Falls back to a single adapter.insert() for batches of 1.
     */
    const flushAssertBatch = (
      assertOps: readonly TransactOp[],
      txId: string,
      timestamp: number,
      position: number,
      actor?: string,
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
            createdBy: op.createdBy ?? actor,
            validFrom: op.validFrom,
            validTo: op.validTo,
          };
        });

        if (inputs.length === 1) {
          const row = yield* adapter.insert(
            inputs[0]!,
            txId,
            timestamp,
            yield* nextTripleId,
            position,
          );
          return [rowToTriple(row)];
        }

        const rows = yield* adapter.batchInsert(
          inputs,
          txId,
          timestamp,
          yield* Effect.all(inputs.map(() => nextTripleId)),
          position,
        );
        return rows.map(rowToTriple);
      });

    const transact = (
      operations: readonly TransactOp[],
      meta?: TransactionMeta,
    ): Effect.Effect<TransactionResult, WriteError | ReadError | TransactionConflictError> =>
      adapter.withTransaction(
        Effect.gen(function* () {
          if (!isSystemWriteAuthorized(meta)) {
            const reserved = reservedAssertError(operations);
            if (reserved) return yield* Effect.fail(reserved);
          }
          const invalidCondition = validatePreconditions(operations, meta);
          if (invalidCondition) {
            return yield* Effect.fail(
              new WriteError({
                message: `Transaction precondition ${invalidCondition} must have a matching retract operation`,
              }),
            );
          }
          const txId = yield* nextTxId;
          const timestamp = yield* now;
          const position = yield* adapter.nextCommitPosition();
          const actor = meta?.actor ?? meta?.user;
          const preconditionIds = livePreconditionIds(meta);

          const triples: Triple[] = [];
          const changes: import("./Triples.js").TransactionChange[] = [];
          let retractedCount = 0;

          let pendingAsserts: TransactOp[] = [];

          for (const op of operations) {
            if (op.op === "assert") {
              pendingAsserts.push(op);
              continue;
            }

            if (pendingAsserts.length > 0) {
              const batch = yield* flushAssertBatch(
                pendingAsserts,
                txId,
                timestamp,
                position,
                actor,
              );
              triples.push(...batch);
              changes.push(
                ...batch.map((triple) =>
                  transactionChangeFromTriple("assert", triple, txId, timestamp),
                ),
              );
              pendingAsserts = [];
            }

            switch (op.op) {
              case "retract": {
                const current = yield* adapter.getById(op.id as string);
                if (current && !isSystemWriteAuthorized(meta)) {
                  const reserved = reservedWriteError({
                    entityId: current.entity_id,
                    attribute: current.attribute,
                    entityType: current.entity_type ?? undefined,
                  });
                  if (reserved) return yield* Effect.fail(reserved);
                }
                const didRetract = yield* adapter.retract(
                  op.id as string,
                  timestamp,
                  txId,
                  position,
                );
                if (!didRetract && preconditionIds.has(op.id as string)) {
                  return yield* Effect.fail(
                    new TransactionConflictError({
                      tripleId: op.id as string,
                      message: `Expected live triple ${op.id}, but another transaction changed it`,
                    }),
                  );
                }
                if (didRetract) {
                  retractedCount++;
                  if (current) {
                    changes.push(
                      transactionChangeFromTriple("retract", rowToTriple(current), txId, timestamp),
                    );
                  }
                }
                break;
              }
              case "retract-pattern": {
                const pattern = queryToPattern(op.pattern);
                const matched = yield* adapter.query(pattern);
                if (!isSystemWriteAuthorized(meta)) {
                  for (const row of matched) {
                    const reserved = reservedWriteError({
                      entityId: row.entity_id,
                      attribute: row.attribute,
                      entityType: row.entity_type ?? undefined,
                    });
                    if (reserved) return yield* Effect.fail(reserved);
                  }
                }
                for (const row of matched) {
                  if (yield* adapter.retract(row.id, timestamp, txId, position)) {
                    retractedCount++;
                    changes.push(
                      transactionChangeFromTriple("retract", rowToTriple(row), txId, timestamp),
                    );
                  }
                }
                break;
              }
            }
          }

          if (pendingAsserts.length > 0) {
            const batch = yield* flushAssertBatch(pendingAsserts, txId, timestamp, position, actor);
            triples.push(...batch);
            changes.push(
              ...batch.map((triple) =>
                transactionChangeFromTriple("assert", triple, txId, timestamp),
              ),
            );
          }

          for (const input of metadataInputs(txId, position, timestamp, meta, changes)) {
            yield* adapter.insert(input, txId, timestamp, yield* nextTripleId, position);
          }

          return { txId, position, instant: timestamp, triples, retracted: retractedCount };
        }),
      );

    const retract = (id: TripleId): Effect.Effect<void, WriteError> =>
      transact([{ op: "retract", id }]).pipe(
        Effect.flatMap((result) =>
          result.retracted === 1
            ? Effect.void
            : Effect.fail(
                new WriteError({ message: `Triple not found or already retracted: ${id}` }),
              ),
        ),
        Effect.mapError((cause) =>
          cause instanceof WriteError
            ? cause
            : new WriteError({ message: `Failed to retract triple: ${id}`, cause }),
        ),
      );

    const retractByPattern = (pattern: Pattern): Effect.Effect<number, WriteError | ReadError> =>
      transact([
        {
          op: "retract-pattern",
          pattern: {
            ...(typeof pattern.entityId === "string" ? { entityId: pattern.entityId } : {}),
            ...(typeof pattern.attribute === "string" ? { attribute: pattern.attribute } : {}),
            ...(pattern.value && !("_tag" in pattern.value) ? { value: pattern.value } : {}),
            ...(pattern.entityType ? { entityType: pattern.entityType } : {}),
          },
        },
      ]).pipe(
        Effect.map((result) => result.retracted),
        Effect.mapError((cause) =>
          cause instanceof WriteError || cause instanceof ReadError
            ? cause
            : new WriteError({ message: "Failed to retract by pattern", cause }),
        ),
      );

    // =========================================================================
    // Triple-level Reads
    // =========================================================================

    const get = (id: TripleId): Effect.Effect<Triple | null, ReadError> =>
      Effect.gen(function* () {
        const row = yield* adapter.getById(id);
        return row ? rowToTriple(row) : null;
      });

    const entity: TriplesService["entity"] = (entityId, basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* now);
        const rows = yield* adapter.getByEntity(entityId, resolved);
        return rows.map(rowToTriple);
      });

    const entitiesById: TriplesService["entitiesById"] = (entityIds, basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* now);
        const rows = yield* adapter.getByEntities(entityIds, resolved);
        return entityIds.map((id) => (rows.get(id) ?? []).map(rowToTriple));
      });

    const match: TriplesService["match"] = (pattern, basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* now);
        const rows = yield* adapter.query(pattern, resolved);
        return rows.map(rowToTriple);
      });

    const matchAsOf = (
      pattern: Pattern,
      asOf: number,
    ): Effect.Effect<readonly Triple[], ReadError> =>
      Effect.gen(function* () {
        const rows = yield* adapter.query(pattern, resolveTemporalBasis(basisFromAsOf(asOf), asOf));
        return rows.map(rowToTriple);
      });

    const history = (entityId: EntityId): Effect.Effect<readonly Triple[], ReadError> =>
      Effect.gen(function* () {
        const rows = yield* adapter.history(entityId);
        return rows.map(rowToTriple);
      });

    const transaction: TriplesService["transaction"] = (txId) =>
      adapter
        .query({ entityId: txId, entityType: "_Transaction" })
        .pipe(Effect.map((rows) => transactionRecordFromTriples(txId, rows.map(rowToTriple))));

    const transactionsByCommand: TriplesService["transactionsByCommand"] = (commandId) =>
      adapter
        .query({ attribute: TxAttributes.COMMAND_ID, value: { type: "string", value: commandId } })
        .pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => transaction(row.entity_id), { concurrency: 16 }),
          ),
          Effect.map((records) =>
            records
              .filter((record): record is NonNullable<typeof record> => record !== null)
              .sort((left, right) => left.position - right.position),
          ),
        );

    const transactions: TriplesService["transactions"] = (request = {}) => {
      const after = request.after ?? 0;
      const limit = request.limit ?? 100;
      if (!Number.isSafeInteger(after) || after < 0) {
        return Effect.fail(
          new ReadError({ message: "Transaction cursor must be a non-negative integer" }),
        );
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        return Effect.fail(
          new ReadError({ message: "Transaction page limit must be between 1 and 1000" }),
        );
      }
      return adapter.query({ entityType: "_Transaction" }).pipe(
        Effect.map((rows) => {
          const page = transactionRecordsFromTriples(rows.map(rowToTriple))
            .filter((record) => record.position > after)
            .slice(0, limit);
          const last = page.at(-1);
          return {
            transactions: page,
            ...(last ? { next: last.position } : {}),
          };
        }),
      );
    };

    // =========================================================================
    // Fluent-builder execution
    // =========================================================================

    const entities = (
      state: QueryState,
    ): Effect.Effect<readonly Triple[], ReadError | QueryError> =>
      Effect.gen(function* () {
        const dialectOpt = yield* Effect.serviceOption(CurrentDialect);
        const dialect: SqlDialect = dialectOpt._tag === "Some" ? dialectOpt.value : SqliteDialect;

        const collector = createParamCollector(dialect);

        const regularFilters = state.filters.filter(
          (f) => f.type !== "exists" && f.type !== "notExists",
        );
        const existenceFilters = state.filters.filter(
          (f) => f.type === "exists" || f.type === "notExists",
        );

        const joins: string[] = [];
        const whereConditions: string[] = [];

        const sortAliases = new Map<string, string>();
        state.sorts.forEach((sort, idx) => {
          const alias = `s${idx + 1}`;
          sortAliases.set(sort.attribute, alias);
          joins.push(
            `LEFT JOIN triples ${alias} ON t0.entity_id = ${alias}.entity_id AND ${alias}.retracted_at IS NULL AND ${alias}.attribute = ${collector.add(sort.attribute)}`,
          );
        });

        whereConditions.push(`t0.entity_type = ${collector.add(state.entityType)}`);
        whereConditions.push(`t0.retracted_at IS NULL`);

        regularFilters.forEach((filter, idx) => {
          const alias = `f${idx + 1}`;
          joins.push(
            `JOIN triples ${alias} ON t0.entity_id = ${alias}.entity_id AND ${alias}.retracted_at IS NULL`,
          );
          whereConditions.push(buildFilterCondition(filter, alias, collector));
        });

        existenceFilters.forEach((filter) => {
          const condition = buildExistsCondition(filter, "t0", collector);
          if (condition) {
            whereConditions.push(condition);
          }
        });

        const entitySort = buildMatchedEntitySort(state.sorts, sortAliases);
        const limitOffsetClause = dialect.limitOffset(state.limit, state.offset);

        const sql = `
          WITH matched_entities AS (
            SELECT t0.entity_id${entitySort.selectClause}
            FROM triples t0
            ${joins.join("\n")}
            WHERE ${whereConditions.join(" AND ")}
            GROUP BY t0.entity_id
          ),
          paged_entities AS (
            SELECT
              entity_id,
              ROW_NUMBER() OVER (ORDER BY ${entitySort.orderBy}) AS entity_rank
            FROM matched_entities
            ORDER BY ${entitySort.orderBy}
            ${limitOffsetClause}
          )
          SELECT t.*
          FROM triples t
          JOIN paged_entities p ON p.entity_id = t.entity_id
          WHERE t.retracted_at IS NULL
          ORDER BY p.entity_rank, t.created_at, t.id
        `.trim();

        const tripleRows = yield* adapter.rawQuery<TripleRow>(sql, [...collector.params]).pipe(
          Effect.mapError(
            (error) =>
              new QueryError({
                message: `Failed to query triples with builder: ${String(error)}`,
                sql,
                cause: error,
              }),
          ),
        );

        return tripleRows.map(rowToTriple);
      });

    // =========================================================================
    // Datalog Reads (via QueryExecutor)
    // =========================================================================

    const query = (q: DatalogQuery, options?: QueryOptions) =>
      Effect.gen(function* () {
        if (options?.basis !== undefined && options.asOf !== undefined) {
          return yield* Effect.fail(
            new ReadError({ message: "Use either basis or asOf, not both" }),
          );
        }
        const basis = resolveTemporalBasis(
          options?.basis ?? (options?.asOf === undefined ? undefined : basisFromAsOf(options.asOf)),
          yield* now,
        );
        return yield* executor.execute(q, options?.debug ?? false, basis);
      }).pipe(Effect.withSpan("triples.query"));

    const queryPage = (q: WrappedQuery, options?: QueryOptions) =>
      Effect.gen(function* () {
        const currentTime = yield* now;
        const recordedPosition = yield* adapter.currentCommitPosition();
        const prepared = yield* Effect.try({
          try: () =>
            preparePagination({
              query: q,
              ...(options?.basis === undefined ? {} : { basis: options.basis }),
              ...(options?.asOf === undefined ? {} : { asOf: options.asOf }),
              now: currentTime,
              recordedPosition,
              scope: runtime.scope,
            }),
          catch: (cause) =>
            cause instanceof PaginationCursorError
              ? cause
              : new PaginationCursorError({
                  reason: "malformed",
                  message: `Failed to prepare pagination: ${String(cause)}`,
                  cause,
                }),
        });
        const result = yield* executor.executePage(
          prepared.query,
          options?.debug ?? false,
          prepared.basis,
          prepared.cursorValues,
        );
        return finishPagination(prepared, result);
      }).pipe(Effect.withSpan("triples.queryPage"));

    const explain = (q: DatalogQuery) =>
      executor.explain(q).pipe(
        Effect.mapError(
          (error) => new DatalogError({ message: error.message, cause: error.cause }),
        ),
        Effect.withSpan("triples.explain"),
      );

    const explainPage = (q: WrappedQuery) =>
      executor.explainPage(q).pipe(
        Effect.mapError(
          (error) => new DatalogError({ message: error.message, cause: error.cause }),
        ),
        Effect.withSpan("triples.explainPage"),
      );

    // =========================================================================
    // Transaction scope
    // =========================================================================

    const withTransaction = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | WriteError> =>
      adapter.withTransaction(effect);

    return {
      assert: assert_,
      assertBatch,
      retract,
      retractByPattern,
      transact,
      withTransaction,
      get,
      entity,
      entitiesById,
      match,
      matchAsOf,
      history,
      transaction,
      transactionsByCommand,
      transactions,
      query,
      queryPage,
      explain,
      explainPage,
      entities,
    } satisfies TriplesService;
  }),
);
