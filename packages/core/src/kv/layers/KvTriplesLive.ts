/**
 * KV-backed implementation of the merged `Triples` service.
 *
 * It calls `createKvTripleStore(kvBackend)` **once** and builds both the
 * write/triple-read path and the Datalog path over that single hexastore
 * handle, keeping their in-memory datom cache coherent.
 */

import { Effect, Layer, Option, Stream } from "effect";
import type { Triple, TripleInput, TripleId, EntityId, TransactOp } from "../../Triple.js";
import type { TripleValue } from "../../Value.js";
import type { Pattern } from "../../types/Pattern.js";
import type { QueryState } from "../../types/QueryBuilder.js";
import type { Filter } from "../../types/Filter.js";
import {
  Triples,
  type TriplesService,
  type BulkInsertOptions,
  type TransactionResult,
  type TransactionMeta,
  type QueryOptions,
} from "../../store/Triples.js";
import type { QueryDebugInfo, QueryMetrics, QueryResult } from "../../storage/QueryExecutor.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import { WriteError, ReadError, TransactionConflictError } from "../../errors/index.js";
import { KvBackend, type KvBackendService, type KvTransaction } from "../kv/KvBackend.js";
import { makeTestKvBackend } from "../kv/InMemoryKvBackend.js";
import { createKvTripleStore, type Datom } from "../hexastore/KvTripleStore.js";
import type { ScanPattern } from "../hexastore/scan.js";
import { executeQuery, executeWrappedQuery } from "../datalog/executor.js";
import { TripleStoreRuntime, TripleStoreRuntimeLayer } from "../../store/TripleStoreRuntime.js";
import {
  livePreconditionIds,
  metadataInputs,
  transactionRecordFromTriples,
  transactionRecordsFromTriples,
  validatePreconditions,
} from "../../store/transactionMetadata.js";
import {
  isSystemWriteAuthorized,
  reservedAssertError,
  reservedWriteError,
} from "../../store/systemNamespace.js";
import { basisFromAsOf, resolveTemporalBasis, type ResolvedTemporalBasis } from "../../Temporal.js";

const COMMIT_POSITION_KEY = new Uint8Array([0x21]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const nextKvCommitPosition = (tx: KvTransaction): Effect.Effect<number, WriteError> =>
  Effect.gen(function* () {
    const stored = yield* tx.get(COMMIT_POSITION_KEY);
    const current = stored === null ? 0 : Number(textDecoder.decode(stored));
    if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
      return yield* Effect.fail(
        new WriteError({ message: "Invalid or exhausted KV commit-position counter" }),
      );
    }
    const next = current + 1;
    yield* tx.set(COMMIT_POSITION_KEY, textEncoder.encode(String(next)));
    return next;
  });

// ─── Datom ↔ Triple conversion ─────────────────────────────────────────────

const datomToTriple = (datom: Datom): Triple => ({
  id: datom.tripleId as TripleId,
  entityId: datom.entity as EntityId,
  attribute: datom.attribute as Triple["attribute"],
  value: datom.value,
  createdAt: datom.createdAt,
  recordedAt: datom.recordedAt,
  validFrom: datom.validFrom,
  validTo: datom.validTo !== null ? Option.some(datom.validTo) : Option.none(),
  createdBy: datom.createdBy !== null ? Option.some(datom.createdBy) : Option.none(),
  retractedAt: datom.retractedAt !== null ? Option.some(datom.retractedAt) : Option.none(),
  recordedRetractedAt:
    datom.recordedRetractedAt !== null ? Option.some(datom.recordedRetractedAt) : Option.none(),
  entityType: datom.entityType !== null ? Option.some(datom.entityType) : Option.none(),
  schemaVersion: Option.none(),
  txId: Option.some(datom.txId),
  retractTxId: datom.retractTxId !== null ? Option.some(datom.retractTxId) : Option.none(),
});

const tripleInputToDatom = (
  input: TripleInput,
  tripleId: string,
  txId: string,
  createdAt: number,
): Datom => ({
  tripleId,
  entity: input.entityId,
  attribute: input.attribute,
  value: input.value,
  txId,
  createdAt,
  recordedAt: createdAt,
  validFrom: input.validFrom ?? createdAt,
  validTo: input.validTo ?? null,
  createdBy: input.createdBy ?? null,
  retractedAt: null,
  recordedRetractedAt: null,
  retractTxId: null,
  entityType: input.entityType ?? null,
});

// ─── Pattern conversion ────────────────────────────────────────────────────

const patternToScan = (pattern: Pattern): ScanPattern => {
  const result: { entity?: string; attribute?: string; value?: TripleValue } = {};

  if (pattern.entityId !== undefined && typeof pattern.entityId === "string") {
    result.entity = pattern.entityId;
  }
  if (pattern.attribute !== undefined && typeof pattern.attribute === "string") {
    result.attribute = pattern.attribute;
  }
  if (
    pattern.value !== undefined &&
    typeof pattern.value === "object" &&
    pattern.value !== null &&
    !("_tag" in pattern.value)
  ) {
    result.value = pattern.value as TripleValue;
  }

  return result;
};

// ─── Filter evaluation (for the fluent builder) ─────────────────────────────

const tripleValueEquals = (tv: TripleValue, raw: unknown): boolean => {
  switch (tv.type) {
    case "string":
    case "ref":
    case "blob":
      return tv.value === raw;
    case "number":
    case "datetime":
      return tv.value === raw;
    case "boolean":
      return tv.value === raw;
    case "json":
      return JSON.stringify(tv.value) === JSON.stringify(raw);
  }
};

const evaluateFilter = (triples: readonly Triple[], filter: Filter): Triple[] => {
  switch (filter.type) {
    case "eq":
      return triples.filter(
        (t) => t.attribute === filter.attribute && tripleValueEquals(t.value, filter.value),
      );
    case "neq":
      return triples.filter(
        (t) => t.attribute !== filter.attribute || !tripleValueEquals(t.value, filter.value),
      );
    case "gt":
      return triples.filter(
        (t) =>
          t.attribute === filter.attribute &&
          t.value.type === "number" &&
          t.value.value > filter.value,
      );
    case "gte":
      return triples.filter(
        (t) =>
          t.attribute === filter.attribute &&
          t.value.type === "number" &&
          t.value.value >= filter.value,
      );
    case "lt":
      return triples.filter(
        (t) =>
          t.attribute === filter.attribute &&
          t.value.type === "number" &&
          t.value.value < filter.value,
      );
    case "lte":
      return triples.filter(
        (t) =>
          t.attribute === filter.attribute &&
          t.value.type === "number" &&
          t.value.value <= filter.value,
      );
    case "contains":
      return triples.filter(
        (t) =>
          t.attribute === filter.attribute &&
          t.value.type === "string" &&
          t.value.value.includes(filter.value),
      );
    case "startsWith":
      return triples.filter(
        (t) =>
          t.attribute === filter.attribute &&
          t.value.type === "string" &&
          t.value.value.startsWith(filter.value),
      );
    case "exists":
      return triples.filter((t) => t.attribute === filter.attribute);
    case "notExists": {
      const entities = new Set(
        triples.filter((t) => t.attribute === filter.attribute).map((t) => t.entityId),
      );
      return triples.filter((t) => !entities.has(t.entityId));
    }
    case "in":
      return triples.filter(
        (t) =>
          t.attribute === filter.attribute &&
          filter.values.some((v) => tripleValueEquals(t.value, v)),
      );
    case "and":
      return filter.filters.reduce((acc, f) => evaluateFilter(acc, f), [...triples]);
    case "or": {
      const sets = filter.filters.map((f) => evaluateFilter(triples, f));
      const seen = new Set<string>();
      const result: Triple[] = [];
      for (const set of sets) {
        for (const t of set) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            result.push(t);
          }
        }
      }
      return result;
    }
    case "not":
      return triples.filter((t) => !evaluateFilter([t], filter.filter).length);
  }
};

const extractSortValue = (tv: TripleValue): string | number | boolean | null => {
  switch (tv.type) {
    case "string":
    case "ref":
    case "blob":
      return tv.value;
    case "number":
    case "datetime":
      return tv.value;
    case "boolean":
      return tv.value;
    case "json":
      return JSON.stringify(tv.value);
  }
};

// ─── Datalog debug metrics (KV backends generate no SQL) ────────────────────

const makeKvMetrics = (query: DatalogQuery): QueryMetrics => ({
  joinCount: 0,
  whereConditionCount: query.where.length,
  subqueryCount: 0,
  cteCount: 0,
  sqlLength: 0,
  paramCount: 0,
  patternCount: query.where.filter((c) => Array.isArray(c) && c.length >= 3 && c.length <= 4)
    .length,
  predicateCount: query.where.filter(
    (c) => Array.isArray(c) && [">", ">=", "<", "<=", "=", "!="].includes(c[0] as string),
  ).length,
  notClauseCount: query.where.filter((c) => Array.isArray(c) && c[0] === "not").length,
  orClauseCount: query.where.filter((c) => Array.isArray(c) && c[0] === "or").length,
  hasAggregation: (query.aggregate?.length ?? 0) > 0,
  isRecursive: (query.rules?.length ?? 0) > 0,
  aggregateOps: (query.aggregate ?? []).map((a) => a[0]),
  compilationTimeMs: 0,
});

/** Adapt a backend transaction to the interface consumed by KvTripleStore. */
const transactionBackend = (tx: KvTransaction): KvBackendService => ({
  get: tx.get,
  set: tx.set,
  delete: tx.delete,
  getRange: tx.getRange,
  transact: (effect) => effect(tx),
  setAll: (entries) =>
    Effect.forEach(entries, ([key, value]) => tx.set(key, value), { discard: true }),
  getMany: (keys) =>
    Effect.forEach(keys, (key) => tx.get(key).pipe(Effect.map((value) => [key, value] as const))),
  clear: () => Effect.die("KvTripleStore.clear is not supported inside a transaction"),
});

// ─── Service implementation ────────────────────────────────────────────────

const makeKvTriplesService = Effect.gen(function* () {
  const kvBackend = yield* KvBackend;
  const runtime = yield* TripleStoreRuntime;

  // Single hexastore handle shared by the write path and the Datalog path so
  // their datom caches can never diverge.
  const hexaStore = createKvTripleStore(kvBackend);

  // === Triple-level reads (needed by retractByPattern below) ===============

  const match = (
    pattern: Pattern,
    basis?: ResolvedTemporalBasis,
  ): Effect.Effect<readonly Triple[], ReadError> =>
    Effect.gen(function* () {
      // Fast path: entityType-only query uses the KV TYPE index
      if (pattern.entityType && !pattern.entityId && !pattern.attribute && !pattern.value) {
        const datoms = basis === undefined ? hexaStore.getByEntityType(pattern.entityType) : null;
        if (datoms !== null) {
          return datoms.map(datomToTriple);
        }
        const asyncDatoms =
          basis === undefined
            ? yield* hexaStore.getByEntityTypeAsync(pattern.entityType)
            : yield* hexaStore.scanCollectTemporalAsync({}, basis);
        return asyncDatoms
          .filter((datom) => datom.entityType === pattern.entityType)
          .map(datomToTriple);
      }

      const scanPat = patternToScan(pattern);
      const syncDatoms =
        basis === undefined
          ? hexaStore.scanCollect(scanPat)
          : hexaStore.scanCollectTemporal(scanPat, basis);
      let results: Triple[];
      if (syncDatoms !== null) {
        if (pattern.entityType) {
          results = [];
          for (let i = 0; i < syncDatoms.length; i++) {
            const d = syncDatoms[i]!;
            if (d.entityType === pattern.entityType) {
              results.push(datomToTriple(d));
            }
          }
          return results;
        }
        results = syncDatoms.map(datomToTriple);
      } else {
        const datoms = yield* basis === undefined
          ? hexaStore.scanCollectAsync(scanPat)
          : hexaStore.scanCollectTemporalAsync(scanPat, basis);
        results = datoms.map(datomToTriple);
      }

      if (pattern.entityType) {
        results = results.filter(
          (t) => Option.isSome(t.entityType) && t.entityType.value === pattern.entityType,
        );
      }

      return results;
    }).pipe(
      Effect.catch((e) =>
        Effect.fail(new ReadError({ message: `Query failed: ${String(e)}`, cause: e })),
      ),
    );

  const service: TriplesService = {
    // === Writes ============================================================

    assert: (input: TripleInput) =>
      Effect.gen(function* () {
        const reserved = reservedWriteError(input);
        if (reserved) return yield* Effect.fail(reserved);
        const tripleId = yield* runtime.nextTripleId;
        const txId = yield* runtime.nextTxId;
        const now = yield* runtime.now;
        const datom = tripleInputToDatom(input, tripleId, txId, now);
        yield* hexaStore.assert(datom);
        return datomToTriple(datom);
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new WriteError({ message: `Assert failed: ${String(e)}`, cause: e })),
        ),
      ),

    assertBatch: (inputs: readonly TripleInput[], _options?: BulkInsertOptions) =>
      Effect.gen(function* () {
        for (const input of inputs) {
          const reserved = reservedWriteError(input);
          if (reserved) return yield* Effect.fail(reserved);
        }
        const txId = yield* runtime.nextTxId;
        const now = yield* runtime.now;
        const datoms = yield* Effect.forEach(inputs, (input) =>
          Effect.gen(function* () {
            const tripleId = yield* runtime.nextTripleId;
            return tripleInputToDatom(input, tripleId, txId, now);
          }),
        );
        yield* hexaStore.assertBatch(datoms);
        return datoms.map(datomToTriple);
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new WriteError({ message: `AssertBatch failed: ${String(e)}`, cause: e })),
        ),
      ),

    retract: (id: TripleId) =>
      Effect.gen(function* () {
        const current = yield* hexaStore.getById(id);
        if (current) {
          const reserved = reservedWriteError({
            entityId: current.entity,
            attribute: current.attribute,
            entityType: current.entityType ?? undefined,
          });
          if (reserved) return yield* Effect.fail(reserved);
        }
        const retracted = yield* hexaStore.retract(id, yield* runtime.now, yield* runtime.nextTxId);
        if (!retracted) {
          yield* Effect.fail(
            new WriteError({ message: `Triple not found or already retracted: ${id}` }),
          );
        }
      }).pipe(
        Effect.catch((e) => {
          if (e instanceof WriteError) return Effect.fail(e);
          return Effect.fail(new WriteError({ message: `Retract failed: ${String(e)}`, cause: e }));
        }),
      ),

    retractByPattern: (pattern: Pattern) =>
      Effect.gen(function* () {
        const scanPat = patternToScan(pattern);
        const syncDatoms = hexaStore.scanCollect(scanPat);
        const scanned = syncDatoms ?? (yield* hexaStore.scanCollectAsync(scanPat));
        const datoms = pattern.entityType
          ? scanned.filter((datom) => datom.entityType === pattern.entityType)
          : scanned;
        for (const datom of datoms) {
          const reserved = reservedWriteError({
            entityId: datom.entity,
            attribute: datom.attribute,
            entityType: datom.entityType ?? undefined,
          });
          if (reserved) return yield* Effect.fail(reserved);
        }
        let count = 0;
        const now = yield* runtime.now;
        const txId = yield* runtime.nextTxId;
        for (const datom of datoms) {
          const ok = yield* hexaStore.retract(datom.tripleId, now, txId);
          if (ok) count++;
        }
        return count;
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(
            new WriteError({ message: `RetractByPattern failed: ${String(e)}`, cause: e }),
          ),
        ),
      ),

    transact: (operations: readonly TransactOp[], meta?: TransactionMeta) =>
      kvBackend
        .transact((tx) => {
          const transactionStore = createKvTripleStore(transactionBackend(tx));
          return Effect.gen(function* () {
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
            const txId = yield* runtime.nextTxId;
            const now = yield* runtime.now;
            const position = yield* nextKvCommitPosition(tx);
            const actor = meta?.actor ?? meta?.user;
            const preconditionIds = livePreconditionIds(meta);
            const asserted: Triple[] = [];
            const changes: Array<{
              readonly op: "assert" | "retract";
              readonly tripleId: string;
              readonly entityId: string;
              readonly attribute: string;
            }> = [];
            let retractedCount = 0;

            for (const op of operations) {
              switch (op.op) {
                case "assert": {
                  const datom = tripleInputToDatom(
                    {
                      entityId: op.entityId,
                      attribute: op.attribute,
                      value: op.value,
                      entityType: op.entityType,
                      createdBy: actor,
                      validFrom: op.validFrom,
                      validTo: op.validTo,
                    },
                    yield* runtime.nextTripleId,
                    txId,
                    now,
                  );
                  yield* transactionStore.assert(datom);
                  const triple = datomToTriple(datom);
                  asserted.push(triple);
                  changes.push({
                    op: "assert",
                    tripleId: triple.id,
                    entityId: triple.entityId,
                    attribute: triple.attribute,
                  });
                  break;
                }
                case "retract": {
                  const current = yield* transactionStore.getById(op.id);
                  if (current && !isSystemWriteAuthorized(meta)) {
                    const reserved = reservedWriteError({
                      entityId: current.entity,
                      attribute: current.attribute,
                      entityType: current.entityType ?? undefined,
                    });
                    if (reserved) return yield* Effect.fail(reserved);
                  }
                  const ok = yield* transactionStore.retract(op.id, now, txId);
                  if (!ok && preconditionIds.has(op.id)) {
                    return yield* Effect.fail(
                      new TransactionConflictError({
                        tripleId: op.id,
                        message: `Expected live triple ${op.id}, but another transaction changed it`,
                      }),
                    );
                  }
                  if (ok) {
                    retractedCount++;
                    if (current) {
                      changes.push({
                        op: "retract",
                        tripleId: current.tripleId,
                        entityId: current.entity,
                        attribute: current.attribute,
                      });
                    }
                  }
                  break;
                }
                case "retract-pattern": {
                  const pat = patternToScan(op.pattern as unknown as Pattern);
                  const scanned = yield* transactionStore.scanCollectAsync(pat);
                  const datoms = op.pattern.entityType
                    ? scanned.filter((datom) => datom.entityType === op.pattern.entityType)
                    : scanned;
                  if (!isSystemWriteAuthorized(meta)) {
                    for (const datom of datoms) {
                      const reserved = reservedWriteError({
                        entityId: datom.entity,
                        attribute: datom.attribute,
                        entityType: datom.entityType ?? undefined,
                      });
                      if (reserved) return yield* Effect.fail(reserved);
                    }
                  }
                  for (const datom of datoms) {
                    const ok = yield* transactionStore.retract(datom.tripleId, now, txId);
                    if (ok) {
                      retractedCount++;
                      changes.push({
                        op: "retract",
                        tripleId: datom.tripleId,
                        entityId: datom.entity,
                        attribute: datom.attribute,
                      });
                    }
                  }
                  break;
                }
              }
            }

            for (const input of metadataInputs(txId, position, now, meta, changes)) {
              yield* transactionStore.assert(
                tripleInputToDatom(input, yield* runtime.nextTripleId, txId, now),
              );
            }

            return {
              txId,
              position,
              instant: now,
              triples: asserted,
              retracted: retractedCount,
            } satisfies TransactionResult;
          });
        })
        .pipe(
          Effect.ensuring(Effect.sync(() => hexaStore.clearCache())),
          Effect.catch((e) =>
            e instanceof WriteError || e instanceof TransactionConflictError
              ? Effect.fail(e)
              : Effect.fail(new WriteError({ message: `Transact failed: ${String(e)}`, cause: e })),
          ),
        ),

    withTransaction: <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.catch((e) => {
          if (e instanceof WriteError) return Effect.fail(e) as Effect.Effect<A, E | WriteError>;
          return Effect.fail(e);
        }),
      ),

    // === Triple-level reads ================================================

    get: (id: TripleId) =>
      Effect.gen(function* () {
        const datom = yield* hexaStore.getById(id);
        return datom !== null ? datomToTriple(datom) : null;
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new ReadError({ message: `Get failed: ${String(e)}`, cause: e })),
        ),
      ),

    entity: (entityId: EntityId, basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* runtime.now);
        const syncDatoms = hexaStore.scanCollectTemporal({ entity: entityId }, resolved);
        if (syncDatoms !== null) {
          return syncDatoms.map(datomToTriple);
        }
        const datoms = yield* hexaStore.scanCollectTemporalAsync({ entity: entityId }, resolved);
        return datoms.map(datomToTriple);
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new ReadError({ message: `Entity failed: ${String(e)}`, cause: e })),
        ),
      ),

    entitiesById: (entityIds, basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* runtime.now);
        return yield* Effect.forEach(entityIds, (entityId) =>
          hexaStore
            .scanCollectTemporalAsync({ entity: entityId }, resolved)
            .pipe(Effect.map((datoms) => datoms.map(datomToTriple))),
        );
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(
            new ReadError({ message: `Batch entity read failed: ${String(e)}`, cause: e }),
          ),
        ),
      ),

    match: (pattern, basis) =>
      Effect.gen(function* () {
        return yield* match(pattern, resolveTemporalBasis(basis, yield* runtime.now));
      }),

    matchAsOf: (pattern: Pattern, asOf: number) =>
      Effect.gen(function* () {
        const scanPat = patternToScan(pattern);
        const datoms = yield* Stream.runCollect(
          hexaStore.scanTemporal(scanPat, resolveTemporalBasis(basisFromAsOf(asOf), asOf)),
        );
        return Array.from(datoms).map(datomToTriple);
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new ReadError({ message: `MatchAsOf failed: ${String(e)}`, cause: e })),
        ),
      ),

    history: (entityId: EntityId) =>
      Effect.gen(function* () {
        const datoms = yield* Stream.runCollect(hexaStore.entityHistory(entityId));
        return Array.from(datoms).map(datomToTriple);
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new ReadError({ message: `History failed: ${String(e)}`, cause: e })),
        ),
      ),

    transaction: (txId: string) =>
      Effect.gen(function* () {
        const datoms = yield* hexaStore.scanCollectAsync({ entity: txId });
        return transactionRecordFromTriples(txId, datoms.map(datomToTriple));
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(
            new ReadError({ message: `Transaction read failed: ${String(e)}`, cause: e }),
          ),
        ),
      ),

    transactions: (request = {}) => {
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
      return match({ entityType: "_Transaction" }).pipe(
        Effect.map((triples) => {
          const page = transactionRecordsFromTriples(triples)
            .filter((record) => record.position > after)
            .slice(0, limit);
          const last = page.at(-1);
          return {
            transactions: page,
            ...(last ? { next: last.position } : {}),
          };
        }),
      );
    },

    // === Datalog reads =====================================================

    query: (q: DatalogQuery, options?: QueryOptions) =>
      Effect.gen(function* () {
        if (options?.basis !== undefined && options.asOf !== undefined) {
          return yield* Effect.fail(
            new ReadError({ message: "Use either basis or asOf, not both" }),
          );
        }
        const basis = resolveTemporalBasis(
          options?.basis ?? (options?.asOf === undefined ? undefined : basisFromAsOf(options.asOf)),
          yield* runtime.now,
        );
        return yield* executeQuery(hexaStore, q, q.rules ?? [], { basis });
      }).pipe(
        Effect.map((result) => {
          const results = result.results as unknown as QueryResult;
          if (options?.debug) {
            const debug: QueryDebugInfo = {
              metrics: makeKvMetrics(q),
              executionTimeMs: 0,
              resultCount: result.results.length,
            };
            return { results, debug };
          }
          return { results };
        }),
        Effect.mapError(
          (e) => new ReadError({ message: `Query execution failed: ${String(e)}`, cause: e }),
        ),
      ),

    queryPage: (q: WrappedQuery, options?: QueryOptions) =>
      Effect.gen(function* () {
        if (options?.basis !== undefined && options.asOf !== undefined) {
          return yield* Effect.fail(
            new ReadError({ message: "Use either basis or asOf, not both" }),
          );
        }
        const basis = resolveTemporalBasis(
          options?.basis ?? (options?.asOf === undefined ? undefined : basisFromAsOf(options.asOf)),
          yield* runtime.now,
        );
        return yield* executeWrappedQuery(hexaStore, q, q.inner.rules ?? [], { basis });
      }).pipe(
        Effect.map((result) => ({
          results: result.results as unknown as QueryResult,
          ...(result.totalCount !== undefined ? { totalCount: result.totalCount } : {}),
          ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
        })),
        Effect.mapError(
          (e) => new ReadError({ message: `Wrapped query failed: ${String(e)}`, cause: e }),
        ),
      ),

    explain: (q: DatalogQuery) =>
      Effect.succeed({
        queryPlan: {
          backend: "kv-store" as const,
          steps: [{ label: "main", query: JSON.stringify(q, null, 2) }],
        },
        metrics: makeKvMetrics(q),
      }),

    explainPage: (q: WrappedQuery) =>
      Effect.succeed({
        queryPlan: {
          backend: "kv-store" as const,
          steps: [{ label: "main", query: JSON.stringify(q, null, 2) }],
        },
      }),

    // === Fluent-builder execution =========================================

    entities: (state: QueryState) =>
      Effect.gen(function* () {
        const typeScanPat: ScanPattern = {
          attribute: ":entity/type",
          value: { type: "string", value: state.entityType },
        };
        const syncTypeDatoms = hexaStore.scanCollect(typeScanPat);
        const entityIds: string[] = [];
        if (syncTypeDatoms !== null) {
          for (let i = 0; i < syncTypeDatoms.length; i++) {
            entityIds.push(syncTypeDatoms[i]!.entity);
          }
        } else {
          const typeDatoms = yield* hexaStore.scanCollectAsync(typeScanPat);
          for (const datom of typeDatoms) {
            entityIds.push(datom.entity);
          }
        }

        let allTriples: Triple[] = [];
        for (const eid of entityIds) {
          const syncEntityDatoms = hexaStore.scanCollect({ entity: eid });
          if (syncEntityDatoms !== null) {
            for (let i = 0; i < syncEntityDatoms.length; i++) {
              allTriples.push(datomToTriple(syncEntityDatoms[i]!));
            }
          } else {
            const entityDatoms = yield* hexaStore.scanCollectAsync({ entity: eid });
            allTriples.push(...entityDatoms.map(datomToTriple));
          }
        }

        for (const filter of state.filters) {
          const matching = evaluateFilter(allTriples, filter);
          const matchingEntities = new Set(matching.map((t) => t.entityId));
          allTriples = allTriples.filter((t) => matchingEntities.has(t.entityId));
        }

        if (state.sorts.length > 0) {
          const byEntity = new Map<string, Triple[]>();
          for (const t of allTriples) {
            const group = byEntity.get(t.entityId) ?? [];
            group.push(t);
            byEntity.set(t.entityId, group);
          }

          const entityOrder = [...byEntity.keys()].sort((a, b) => {
            for (const sort of state.sorts) {
              const aTriple = byEntity.get(a)?.find((t) => t.attribute === sort.attribute);
              const bTriple = byEntity.get(b)?.find((t) => t.attribute === sort.attribute);
              const aVal = aTriple ? extractSortValue(aTriple.value) : null;
              const bVal = bTriple ? extractSortValue(bTriple.value) : null;

              if (aVal === bVal) continue;
              if (aVal === null) return sort.nulls === "first" ? -1 : 1;
              if (bVal === null) return sort.nulls === "first" ? 1 : -1;

              let cmp = 0;
              if (typeof aVal === "number" && typeof bVal === "number") {
                cmp = aVal - bVal;
              } else {
                cmp = String(aVal) < String(bVal) ? -1 : 1;
              }
              if (sort.direction === "desc") cmp = -cmp;
              if (cmp !== 0) return cmp;
            }
            return 0;
          });

          allTriples = entityOrder.flatMap((eid) => byEntity.get(eid) ?? []);
        }

        if (state.offset !== undefined || state.limit !== undefined) {
          const uniqueEntities = [...new Set(allTriples.map((t) => t.entityId))];
          const start = state.offset ?? 0;
          const end = state.limit !== undefined ? start + state.limit : undefined;
          const pageEntities = new Set(uniqueEntities.slice(start, end));
          allTriples = allTriples.filter((t) => pageEntities.has(t.entityId));
        }

        return allTriples;
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new ReadError({ message: `Entities query failed: ${String(e)}`, cause: e })),
        ),
      ),
  };

  return service;
});

// ─── Layers ────────────────────────────────────────────────────────────────

/**
 * Layer providing the merged `Triples` service backed by the KV hexastore.
 * Requires a `KvBackend` (in-memory, FoundationDB, Cloudflare, …) and a
 * `TripleStoreRuntime` (clock + id generation).
 */
export const KvTriplesLive: Layer.Layer<Triples, never, KvBackend | TripleStoreRuntime> =
  Layer.effect(Triples, makeKvTriplesService) as unknown as Layer.Layer<
    Triples,
    never,
    KvBackend | TripleStoreRuntime
  >;

/**
 * Convenience namespace for wiring KV-backed `Triples`.
 */
export const KvTriples = {
  /**
   * `Triples` over the KV hexastore, requiring only a `KvBackend` and
   * `TripleStoreRuntime`. Use this to reuse a real KV backend (e.g. FDB).
   */
  layerBackend: KvTriplesLive,

  /**
   * Fully self-contained in-memory `Triples` — bundles a **fresh** in-memory KV
   * backend and the default runtime. One line to a working store:
   *
   * ```ts
   * program.pipe(Effect.provide(KvTriples.layer))
   * ```
   *
   * Each instantiation gets its own isolated store (unlike the shared
   * `InMemoryKvBackendLive` singleton), which is what you want for tests and
   * ephemeral workloads.
   */
  layer: KvTriplesLive.pipe(
    Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)),
    Layer.provide(TripleStoreRuntimeLayer),
  ),
} as const;
