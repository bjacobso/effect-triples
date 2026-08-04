/**
 * KV-backed implementation of TripleStoreService.
 *
 * Adapts the hexastore KvTripleStore to the TripleStoreService interface
 * expected by the rest of the system. Handles conversion between the
 * domain Triple type (with Options, branded IDs) and the internal Datom type.
 */

import { Effect, Layer, Option, Stream } from "effect";
import type { Triple, TripleInput, TripleId, EntityId, TransactOp } from "../../Triple.js";
import type { TripleValue } from "../../Value.js";
import type { Pattern } from "../../types/Pattern.js";
import type { QueryState } from "../../types/QueryBuilder.js";
import type { Filter } from "../../types/Filter.js";
import {
  TripleStore,
  type TripleStoreService,
  type BulkInsertOptions,
  type TransactionResult,
  type TransactionMeta,
} from "../../store/TripleStore.js";
import { WriteError, ReadError } from "../../errors/index.js";
import { KvBackend } from "../kv/KvBackend.js";
import { createKvTripleStore, type Datom } from "../hexastore/KvTripleStore.js";
import type { ScanPattern } from "../hexastore/scan.js";
import { TripleStoreRuntime } from "../../store/TripleStoreRuntime.js";

// ─── Datom ↔ Triple conversion ─────────────────────────────────────────────

const datomToTriple = (datom: Datom): Triple => ({
  id: datom.tripleId as TripleId,
  entityId: datom.entity as EntityId,
  attribute: datom.attribute as Triple["attribute"],
  value: datom.value,
  createdAt: datom.createdAt,
  createdBy: datom.createdBy !== null ? Option.some(datom.createdBy) : Option.none(),
  retractedAt: datom.retractedAt !== null ? Option.some(datom.retractedAt) : Option.none(),
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
  createdBy: input.createdBy ?? null,
  retractedAt: null,
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

// ─── Filter evaluation ─────────────────────────────────────────────────────

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

// ─── Service implementation ────────────────────────────────────────────────

const makeKvTripleStoreService = Effect.gen(function* () {
  const kvBackend = yield* KvBackend;
  const runtime = yield* TripleStoreRuntime;
  const hexaStore = createKvTripleStore(kvBackend);

  const service: TripleStoreService = {
    assert: (input: TripleInput) =>
      Effect.gen(function* () {
        const tripleId = yield* runtime.nextTripleId;
        const txId = yield* runtime.nextTxId;
        const now = yield* runtime.now;
        const datom = tripleInputToDatom(input, tripleId, txId, now);
        yield* hexaStore.assert(datom);
        return datomToTriple(datom);
      }).pipe(
        Effect.catchAll((e) =>
          Effect.fail(new WriteError({ message: `Assert failed: ${String(e)}`, cause: e })),
        ),
      ),

    assertBatch: (inputs: readonly TripleInput[], _options?: BulkInsertOptions) =>
      Effect.gen(function* () {
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
        Effect.catchAll((e) =>
          Effect.fail(new WriteError({ message: `AssertBatch failed: ${String(e)}`, cause: e })),
        ),
      ),

    retract: (id: TripleId) =>
      Effect.gen(function* () {
        const retracted = yield* hexaStore.retract(id, yield* runtime.now, yield* runtime.nextTxId);
        if (!retracted) {
          yield* Effect.fail(
            new WriteError({ message: `Triple not found or already retracted: ${id}` }),
          );
        }
      }).pipe(
        Effect.catchAll((e) => {
          if (e instanceof WriteError) return Effect.fail(e);
          return Effect.fail(new WriteError({ message: `Retract failed: ${String(e)}`, cause: e }));
        }),
      ),

    retractByPattern: (pattern: Pattern) =>
      Effect.gen(function* () {
        const scanPat = patternToScan(pattern);
        const syncDatoms = hexaStore.scanCollect(scanPat);
        const datoms = syncDatoms ?? (yield* hexaStore.scanCollectAsync(scanPat));
        let count = 0;
        const now = yield* runtime.now;
        const txId = yield* runtime.nextTxId;
        for (const datom of datoms) {
          const ok = yield* hexaStore.retract(datom.tripleId, now, txId);
          if (ok) count++;
        }
        return count;
      }).pipe(
        Effect.catchAll((e) =>
          Effect.fail(
            new WriteError({ message: `RetractByPattern failed: ${String(e)}`, cause: e }),
          ),
        ),
      ),

    transact: (operations: readonly TransactOp[], meta?: TransactionMeta) =>
      Effect.gen(function* () {
        const txId = yield* runtime.nextTxId;
        const now = yield* runtime.now;
        const asserted: Triple[] = [];
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
                  createdBy: meta?.user,
                },
                yield* runtime.nextTripleId,
                txId,
                now,
              );
              yield* hexaStore.assert(datom);
              asserted.push(datomToTriple(datom));
              break;
            }
            case "retract": {
              const ok = yield* hexaStore.retract(op.id, now, txId);
              if (ok) retractedCount++;
              break;
            }
            case "retract-pattern": {
              const pat = patternToScan(op.pattern as unknown as Pattern);
              const syncPat = hexaStore.scanCollect(pat);
              const datoms = syncPat ?? (yield* hexaStore.scanCollectAsync(pat));
              for (const datom of datoms) {
                const ok = yield* hexaStore.retract(datom.tripleId, now, txId);
                if (ok) retractedCount++;
              }
              break;
            }
          }
        }

        return {
          txId,
          triples: asserted,
          retracted: retractedCount,
        } satisfies TransactionResult;
      }).pipe(
        Effect.catchAll((e) =>
          Effect.fail(new WriteError({ message: `Transact failed: ${String(e)}`, cause: e })),
        ),
      ),

    getTriple: (id: TripleId) =>
      Effect.gen(function* () {
        const datom = yield* hexaStore.getById(id);
        return datom !== null ? datomToTriple(datom) : null;
      }).pipe(
        Effect.catchAll((e) =>
          Effect.fail(new ReadError({ message: `GetTriple failed: ${String(e)}`, cause: e })),
        ),
      ),

    getEntity: (entityId: EntityId) =>
      Effect.gen(function* () {
        // Sync fast path
        const syncDatoms = hexaStore.scanCollect({ entity: entityId });
        if (syncDatoms !== null) {
          return syncDatoms.map(datomToTriple);
        }
        // Batched async path (2 round trips instead of N+1)
        const datoms = yield* hexaStore.scanCollectAsync({ entity: entityId });
        return datoms.map(datomToTriple);
      }).pipe(
        Effect.catchAll((e) =>
          Effect.fail(new ReadError({ message: `GetEntity failed: ${String(e)}`, cause: e })),
        ),
      ),

    query: (pattern: Pattern) =>
      Effect.gen(function* () {
        // Fast path: entityType-only query uses the KV TYPE index
        if (pattern.entityType && !pattern.entityId && !pattern.attribute && !pattern.value) {
          const datoms = hexaStore.getByEntityType(pattern.entityType);
          if (datoms !== null) {
            return datoms.map(datomToTriple);
          }
          // Batched async path for entity type queries (FDB)
          const asyncDatoms = yield* hexaStore.getByEntityTypeAsync(pattern.entityType);
          return asyncDatoms.map(datomToTriple);
        }

        const scanPat = patternToScan(pattern);

        // Use sync scan path when available (Datom cache eliminates JSON.parse overhead)
        const syncDatoms = hexaStore.scanCollect(scanPat);
        let results: Triple[];
        if (syncDatoms !== null) {
          // If filtering by entityType, filter at the Datom level to avoid
          // creating Triple objects for non-matching datoms
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
          // Batched async path (2 round trips instead of N+1)
          const datoms = yield* hexaStore.scanCollectAsync(scanPat);
          results = datoms.map(datomToTriple);
        }

        // Apply entityType filter if specified (async path only)
        if (pattern.entityType) {
          results = results.filter(
            (t) => Option.isSome(t.entityType) && t.entityType.value === pattern.entityType,
          );
        }

        return results;
      }).pipe(
        Effect.catchAll((e) =>
          Effect.fail(new ReadError({ message: `Query failed: ${String(e)}`, cause: e })),
        ),
      ),

    queryAsOf: (pattern: Pattern, asOf: number) =>
      Effect.gen(function* () {
        const scanPat = patternToScan(pattern);
        const datoms = yield* Stream.runCollect(hexaStore.scanAsOf(scanPat, asOf));
        return Array.from(datoms).map(datomToTriple);
      }).pipe(
        Effect.catchAll((e) =>
          Effect.fail(new ReadError({ message: `QueryAsOf failed: ${String(e)}`, cause: e })),
        ),
      ),

    history: (entityId: EntityId) =>
      Effect.gen(function* () {
        const datoms = yield* Stream.runCollect(hexaStore.entityHistory(entityId));
        return Array.from(datoms).map(datomToTriple);
      }).pipe(
        Effect.catchAll((e) =>
          Effect.fail(new ReadError({ message: `History failed: ${String(e)}`, cause: e })),
        ),
      ),

    queryWithBuilder: (state: QueryState) =>
      Effect.gen(function* () {
        // Find entities of the specified type using AVET index
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

        // Get all triples for matching entities
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

        // Apply filters
        for (const filter of state.filters) {
          const matching = evaluateFilter(allTriples, filter);
          const matchingEntities = new Set(matching.map((t) => t.entityId));
          allTriples = allTriples.filter((t) => matchingEntities.has(t.entityId));
        }

        // Apply sorting
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

        // Apply limit/offset on entities
        if (state.offset !== undefined || state.limit !== undefined) {
          const uniqueEntities = [...new Set(allTriples.map((t) => t.entityId))];
          const start = state.offset ?? 0;
          const end = state.limit !== undefined ? start + state.limit : undefined;
          const pageEntities = new Set(uniqueEntities.slice(start, end));
          allTriples = allTriples.filter((t) => pageEntities.has(t.entityId));
        }

        return allTriples;
      }).pipe(
        Effect.catchAll((e) =>
          Effect.fail(
            new ReadError({ message: `QueryWithBuilder failed: ${String(e)}`, cause: e }),
          ),
        ),
      ),

    withTransaction: <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.catchAll((e) => {
          if (e instanceof WriteError) return Effect.fail(e) as Effect.Effect<A, E | WriteError>;
          return Effect.fail(e);
        }),
      ),
  };

  return service;
});

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

// ─── Layer ─────────────────────────────────────────────────────────────────

/**
 * Layer that provides TripleStoreService backed by the KV hexastore.
 * Requires KvBackend.
 */
export const KvTripleStoreLive: Layer.Layer<TripleStore, never, KvBackend | TripleStoreRuntime> =
  Layer.effect(TripleStore, makeKvTripleStoreService) as unknown as Layer.Layer<
    TripleStore,
    never,
    KvBackend | TripleStoreRuntime
  >;
