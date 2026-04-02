/**
 * EntitySnapshots capability — materializes JSON snapshots + content hashes
 * on every write operation.
 *
 * This is a proper `StoreCapability` wrapping the snapshot materialization logic
 * from `wrapStoreWithSnapshots`. Write operations trigger synchronous snapshot
 * materialization for all touched entities. The `getEntity` method is enhanced
 * with a snapshot fast-path when a reader is available.
 *
 * Priority: 60 (above ChangeEmission at 50, below AuditLog)
 * Requires: none
 *
 * @see specs/core/entity-snapshots.md
 * @see specs/core/composable-store.md
 */

import { Effect, Either, Encoding, Option, pipe } from "effect";
import type { StoreCapability } from "../store/StoreCapability.js";
import type { TripleStoreService } from "../store/TripleStore.js";
import type { SnapshotWriterShape, SnapshotServiceShape } from "./SnapshotService.js";
import type { Triple, EntityId } from "@open-ontology/database";
import { generateTransactionId, SystemPrefixes, TxAttributes } from "../utils/id.js";
import { WriteError } from "../errors/index.js";

const SNAPSHOT_ID_PREFIX = "snap:";

const decodePart = (value: string): string =>
  Either.getOrThrow(Encoding.decodeBase64UrlString(value));

const parseSnapshotTripleId = (
  id: string,
): { entityId: string; attribute: string; index: number; value: Triple["value"] } | null => {
  if (!id.startsWith(SNAPSHOT_ID_PREFIX)) return null;
  const parts = id.slice(SNAPSHOT_ID_PREFIX.length).split(":");
  if (parts.length !== 4) return null;
  const [encodedEntityId, encodedAttribute, indexRaw, encodedValue] = parts;
  const index = Number(indexRaw);
  if (!Number.isInteger(index) || index < 0) return null;

  try {
    return {
      entityId: decodePart(encodedEntityId!),
      attribute: decodePart(encodedAttribute!),
      index,
      value: JSON.parse(decodePart(encodedValue!)) as Triple["value"],
    };
  } catch {
    return null;
  }
};

const resolveTxTime = (
  store: TripleStoreService,
  txId: string,
  assertedTriples: readonly Triple[],
): Effect.Effect<number, WriteError> =>
  Effect.gen(function* () {
    if (assertedTriples.length > 0) {
      return assertedTriples[0]!.createdAt;
    }

    const txMetaTriples = yield* store
      .query({ entityId: txId, attribute: TxAttributes.INSTANT })
      .pipe(Effect.catchAll(() => Effect.succeed([] as readonly Triple[])));
    const txInstant = txMetaTriples.find((triple) => triple.value.type === "datetime");
    if (txInstant && txInstant.value.type === "datetime") {
      return txInstant.value.value;
    }

    return yield* Effect.fail(
      new WriteError({
        message: `Unable to resolve tx time for ${txId}`,
      }),
    );
  });

const resolveRetractionMeta = (
  store: TripleStoreService,
  entityId: EntityId,
  tripleId: Triple["id"],
): Effect.Effect<{ txId: string; txTime: number } | null> =>
  Effect.gen(function* () {
    const history = yield* store
      .history(entityId)
      .pipe(Effect.catchAll(() => Effect.succeed([] as readonly Triple[])));
    const retracted = history.find(
      (triple) =>
        triple.id === tripleId &&
        Option.isSome(triple.retractedAt) &&
        Option.isSome(triple.retractTxId),
    );

    if (
      !retracted ||
      Option.isNone(retracted.retractedAt) ||
      Option.isNone(retracted.retractTxId)
    ) {
      return null;
    }

    return {
      txId: retracted.retractTxId.value,
      txTime: retracted.retractedAt.value,
    };
  });

/**
 * Map snapshot errors to WriteError.
 *
 * Unlike ChangeEmission and ReactiveConstraints (which swallow errors), snapshot
 * materialization errors are intentionally propagated as WriteError. This is
 * because snapshots are written inside the same database transaction as the
 * triples — if materialization fails, the transaction should be rolled back
 * to maintain consistency between triples and their snapshots.
 */
const mapMaterializeError = (cause: unknown): WriteError =>
  new WriteError({
    message: "Failed to materialize entity snapshot",
    cause,
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect unique entity IDs from a set of triples.
 */
const uniqueEntityIds = (triples: readonly Triple[]): string[] => [
  ...new Set(triples.map((t) => t.entityId)),
];

// ---------------------------------------------------------------------------
// Capability Factory
// ---------------------------------------------------------------------------

/**
 * Create an EntitySnapshots capability.
 *
 * @param writer - Snapshot writer for materializing snapshots on writes
 * @param _reader - Reserved for future snapshot-based read fast paths
 */
export const makeEntitySnapshotsCapability = (
  writer: SnapshotWriterShape,
  _reader?: SnapshotServiceShape,
): StoreCapability => ({
  name: "EntitySnapshots",
  priority: 60,
  requires: [],
  wrap: (store: TripleStoreService): TripleStoreService => ({
    // -----------------------------------------------------------------------
    // Read operations — enhanced getEntity, rest pass through
    // -----------------------------------------------------------------------

    getTriple: store.getTriple,

    // NOTE: The snapshot-based getEntity fast-path is intentionally disabled.
    // snapshotToTriples() produces synthetic `snap:` IDs that don't conform
    // to the TripleId brand (^[0-9A-Z]{26}$), causing schema validation
    // failures in callers that serialize Triple objects. The SnapshotService
    // should be queried directly for snapshot data; getEntity always returns
    // real triples from the underlying store.
    getEntity: store.getEntity,

    query: store.query,
    queryAsOf: store.queryAsOf,
    history: store.history,
    queryWithBuilder: store.queryWithBuilder,

    // -----------------------------------------------------------------------
    // Write operations — materialize snapshots after each write
    // -----------------------------------------------------------------------

    assert: (input) =>
      pipe(
        store.assert(input),
        Effect.tap((triple) =>
          writer
            .materialize(
              Option.getOrElse(triple.txId, () => generateTransactionId()),
              triple.createdAt,
              [triple.entityId],
            )
            .pipe(Effect.mapError(mapMaterializeError)),
        ),
      ),

    assertBatch: (inputs, options) =>
      pipe(
        store.assertBatch(inputs, options),
        Effect.tap((triples) => {
          if (triples.length === 0) return Effect.void;
          const entityIds = uniqueEntityIds(triples);
          const first = triples[0]!;
          return writer
            .materialize(
              Option.getOrElse(first.txId, () => generateTransactionId()),
              first.createdAt,
              entityIds,
            )
            .pipe(Effect.mapError(mapMaterializeError));
        }),
      ),

    retract: (id) =>
      Effect.gen(function* () {
        const parsed = parseSnapshotTripleId(id as string);

        if (parsed) {
          const candidates = yield* store
            .query({
              entityId: parsed.entityId,
              attribute: parsed.attribute,
              value: parsed.value,
            })
            .pipe(Effect.catchAll(() => Effect.succeed([] as readonly Triple[])));

          if (candidates.length === 0) {
            return;
          }

          const sortedCandidates = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
          const target = sortedCandidates[Math.min(parsed.index, sortedCandidates.length - 1)]!;
          yield* store.retract(target.id);
          const meta = yield* resolveRetractionMeta(store, target.entityId as EntityId, target.id);
          if (!meta) {
            return yield* Effect.fail(
              new WriteError({
                message: `Unable to resolve retract tx metadata for triple ${target.id}`,
              }),
            );
          }
          yield* writer
            .materialize(meta.txId, meta.txTime, [target.entityId])
            .pipe(Effect.mapError(mapMaterializeError));
          return;
        }

        const triple = yield* store.getTriple(id).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!triple) {
          yield* store.retract(id);
          return;
        }

        yield* store.retract(id);
        const meta = yield* resolveRetractionMeta(store, triple.entityId as EntityId, triple.id);
        if (!meta) {
          return yield* Effect.fail(
            new WriteError({
              message: `Unable to resolve retract tx metadata for triple ${String(id)}`,
            }),
          );
        }
        yield* writer
          .materialize(meta.txId, meta.txTime, [triple.entityId])
          .pipe(Effect.mapError(mapMaterializeError));
      }).pipe(
        Effect.mapError((error) =>
          error && typeof error === "object" && "_tag" in error && error._tag === "WriteError"
            ? (error as WriteError)
            : new WriteError({ message: "Failed to retract triple", cause: error }),
        ),
      ),

    retractByPattern: (pattern) =>
      Effect.gen(function* () {
        const matchingTriples = yield* store
          .query(pattern)
          .pipe(Effect.catchAll(() => Effect.succeed([] as readonly Triple[])));
        const count = yield* store.retractByPattern(pattern);
        if (matchingTriples.length > 0) {
          const anchor = matchingTriples[0]!;
          const meta = yield* resolveRetractionMeta(store, anchor.entityId as EntityId, anchor.id);
          if (!meta) {
            return yield* Effect.fail(
              new WriteError({
                message: `Unable to resolve retract tx metadata for pattern retraction`,
              }),
            );
          }
          const entityIds = uniqueEntityIds(matchingTriples);
          yield* writer
            .materialize(meta.txId, meta.txTime, entityIds)
            .pipe(Effect.mapError(mapMaterializeError));
        }
        return count;
      }),

    transact: (operations, meta) =>
      Effect.gen(function* () {
        // Pre-fetch triples for retract-by-ID ops to resolve entityIds
        const retractEntityMap = new Map<string, string>();
        for (const op of operations) {
          if (op.op === "retract") {
            const triple = yield* store
              .getTriple(op.id as any)
              .pipe(Effect.catchAll(() => Effect.succeed(null)));
            if (triple) {
              retractEntityMap.set(op.id, triple.entityId);
            }
          }
        }

        const result = yield* store.transact(operations, meta);

        // Collect all entity IDs touched by the transaction
        const entityIds = new Set<string>();

        for (const triple of result.triples) {
          entityIds.add(triple.entityId);
        }

        for (const op of operations) {
          if (op.op === "assert") {
            entityIds.add(op.entityId);
          } else if (op.op === "retract") {
            const eid = retractEntityMap.get(op.id);
            if (eid) entityIds.add(eid);
          } else if (op.op === "retract-pattern" && typeof op.pattern.entityId === "string") {
            entityIds.add(op.pattern.entityId);
          }
        }

        // Filter out _Transaction metadata entities
        const filteredIds = [...entityIds].filter(
          (id) => !id.startsWith(`${SystemPrefixes.TRANSACTION}/`),
        );

        if (filteredIds.length > 0) {
          const txTime = yield* resolveTxTime(store, result.txId, result.triples);
          yield* writer
            .materialize(result.txId, txTime, filteredIds)
            .pipe(Effect.mapError(mapMaterializeError));
        }

        return result;
      }),

    // Transaction scope — pass through unchanged
    withTransaction: store.withTransaction,
  }),
});
