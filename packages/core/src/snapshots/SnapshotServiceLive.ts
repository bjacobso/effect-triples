/**
 * SnapshotService + SnapshotWriter implementation
 *
 * Uses the StorageAdapter's rawQuery for snapshot-specific SQL operations.
 * All snapshot reads/writes go through the same database connection as the triple store.
 */

import { Clock, Effect, Layer, Option } from "effect";
import { StorageAdapter } from "../storage/StorageAdapter.js";
import { TripleStore } from "../store/TripleStore.js";
import { TxAttributes } from "../utils/id.js";
import {
  SnapshotService,
  SnapshotWriter,
  SnapshotError,
  type SnapshotServiceShape,
  type SnapshotWriterShape,
} from "./SnapshotService.js";
import {
  type EntitySnapshot,
  type SnapshotAttributeMap,
  type SnapshotValue,
  triplesToAttributeMap,
  canonicalize,
  hashCanonical,
  diffAttributes,
  EMPTY_ENTITY_HASH,
  FORMAT_VERSION,
} from "./canonical.js";
import type { EntityId } from "../Triple.js";
import type {
  EntitySnapshotResponse,
  TransactionDetailResponse,
  TransactionSummary,
} from "../Snapshot.js";

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

interface EntitySnapshotRow {
  entity_id: string;
  tx_id: string;
  hash: string;
  tx_time: number;
  entity_type: string | null;
}

interface TransactionRow {
  tx_id: string;
  timestamp: number | null;
  user: string | null;
}

interface CountRow {
  tx_id: string;
  count: number | bigint;
}

interface TotalCountRow {
  total: number | bigint;
}

interface AffectedEntityRow {
  tx_id: string;
  entity_id: string;
}

interface ChangedTripleRow {
  entity_id: string;
  attribute: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseSnapshotBlob = (data: string): SnapshotAttributeMap => {
  const entries: Array<[string, SnapshotValue | SnapshotValue[]]> = JSON.parse(data);
  const result: SnapshotAttributeMap = {};
  for (const [key, value] of entries) {
    result[key] = value;
  }
  return result;
};

const buildSnapshot = (row: EntitySnapshotRow, data: string): EntitySnapshot => ({
  entityId: row.entity_id,
  entityType: row.entity_type,
  attributes: parseSnapshotBlob(data),
  hash: row.hash,
  txId: row.tx_id,
  txTime: row.tx_time,
});

const TX_ENTITY_PREFIX = "_tx/";
const TX_ATTRIBUTE_PREFIX = ":_tx/";
const MAX_TRANSACTION_PAGE_SIZE = 200;

const clampTransactionLimit = (limit: number | undefined): number => {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(MAX_TRANSACTION_PAGE_SIZE, Math.floor(limit)));
};

const encodeTransactionCursor = (timestamp: number, txId: string): string =>
  `${timestamp}:${encodeURIComponent(txId)}`;

const decodeTransactionCursor = (
  cursor: string | undefined,
): { readonly timestamp: number; readonly txId: string } | null => {
  if (!cursor) return null;

  const separator = cursor.indexOf(":");
  if (separator <= 0) return null;

  const timestamp = Number(cursor.slice(0, separator));
  if (!Number.isFinite(timestamp)) return null;

  return {
    timestamp,
    txId: decodeURIComponent(cursor.slice(separator + 1)),
  };
};

const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(", ");

const freezeTransactionAggregates = (
  aggregateMap: ReadonlyMap<
    string,
    {
      readonly assertCount: number;
      readonly retractCount: number;
      readonly affectedEntities: Set<string>;
    }
  >,
): ReadonlyMap<
  string,
  {
    readonly assertCount: number;
    readonly retractCount: number;
    readonly affectedEntities: readonly string[];
  }
> =>
  new Map(
    [...aggregateMap.entries()].map(([txId, aggregate]) => [
      txId,
      {
        assertCount: aggregate.assertCount,
        retractCount: aggregate.retractCount,
        affectedEntities: [...aggregate.affectedEntities].sort(),
      },
    ]),
  );

// ---------------------------------------------------------------------------
// SnapshotWriter Implementation
// ---------------------------------------------------------------------------

const makeSnapshotWriter = Effect.gen(function* () {
  const adapter = yield* StorageAdapter;
  const store = yield* TripleStore;

  const materialize: SnapshotWriterShape["materialize"] = (txId, txTime, changedEntityIds) =>
    Effect.gen(function* () {
      const snapshots: EntitySnapshot[] = [];

      for (const entityId of changedEntityIds) {
        // Read current active triples for this entity
        const triples = yield* store.getEntity(entityId as EntityId).pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to read entity ${entityId}: ${e.message}`,
                cause: e,
              }),
          ),
        );

        // Build canonical JSON and hash
        const attributes = triplesToAttributeMap(triples);
        const canonical = canonicalize(attributes);
        const hash = hashCanonical(canonical);
        const byteSize = new TextEncoder().encode(canonical).byteLength;

        // Determine entity type from triples (first one with entity_type set)
        const entityType = triples.reduce<string | null>((acc, t) => {
          if (acc) return acc;
          return Option.isSome(t.entityType) ? t.entityType.value : null;
        }, null);

        // Upsert blob (INSERT OR IGNORE for dedup, then increment ref_count).
        // TODO: ref_count is incremented here but never decremented — the
        // decrement side should be implemented when blob garbage collection
        // is built (delete blobs where ref_count = 0). See entity-snapshots spec.
        yield* adapter
          .rawQuery(
            `INSERT INTO entity_blobs (hash, data, format_version, byte_size, ref_count)
             VALUES (?, ?, ?, ?, 1)
             ON CONFLICT(hash) DO UPDATE SET ref_count = ref_count + 1`,
            [hash, canonical, FORMAT_VERSION, byteSize],
          )
          .pipe(
            Effect.mapError(
              (e) =>
                new SnapshotError({
                  message: `Failed to upsert blob: ${String(e)}`,
                  cause: e,
                }),
            ),
          );

        // Insert snapshot pointer
        yield* adapter
          .rawQuery(
            `INSERT INTO entity_snapshots (entity_id, tx_id, hash, tx_time, entity_type)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(entity_id, tx_id) DO UPDATE SET hash = excluded.hash, tx_time = excluded.tx_time, entity_type = excluded.entity_type`,
            [entityId, txId, hash, txTime, entityType],
          )
          .pipe(
            Effect.mapError(
              (e) =>
                new SnapshotError({
                  message: `Failed to insert snapshot: ${String(e)}`,
                  cause: e,
                }),
            ),
          );

        snapshots.push({
          entityId,
          entityType,
          attributes,
          hash,
          txId,
          txTime,
        });
      }

      return snapshots;
    });

  const backfill: SnapshotWriterShape["backfill"] = () =>
    Effect.gen(function* () {
      // Find all entity IDs that don't have a snapshot yet
      const rows = yield* adapter
        .rawQuery<{ entity_id: string }>(
          `SELECT DISTINCT entity_id FROM triples
           WHERE retracted_at IS NULL
           AND entity_id NOT IN (SELECT DISTINCT entity_id FROM entity_snapshots)`,
          [],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to find entities for backfill: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      if (rows.length === 0) return 0;

      const entityIds = rows.map((r) => r.entity_id);
      const now = yield* Clock.currentTimeMillis;
      const txId = `backfill:${now}`;
      const txTime = now;

      yield* materialize(txId, txTime, entityIds);
      return entityIds.length;
    });

  return { materialize, backfill } satisfies SnapshotWriterShape;
});

// ---------------------------------------------------------------------------
// SnapshotService Implementation
// ---------------------------------------------------------------------------

const makeSnapshotService = Effect.gen(function* () {
  const adapter = yield* StorageAdapter;

  const loadTransactionAggregates = (
    txIds: readonly string[],
  ): Effect.Effect<
    ReadonlyMap<
      string,
      {
        readonly assertCount: number;
        readonly retractCount: number;
        readonly affectedEntities: readonly string[];
      }
    >,
    SnapshotError
  > =>
    Effect.gen(function* () {
      const aggregateMap = new Map<
        string,
        { assertCount: number; retractCount: number; affectedEntities: Set<string> }
      >();

      for (const txId of txIds) {
        aggregateMap.set(txId, { assertCount: 0, retractCount: 0, affectedEntities: new Set() });
      }

      if (txIds.length === 0) return freezeTransactionAggregates(aggregateMap);

      const inClause = placeholders(txIds.length);
      const systemEntityPrefixLength = TX_ENTITY_PREFIX.length;
      const systemAttributePrefixLength = TX_ATTRIBUTE_PREFIX.length;

      const assertRows = yield* adapter
        .rawQuery<CountRow>(
          `SELECT tx_id, COUNT(*) AS count
           FROM triples
           WHERE tx_id IN (${inClause})
             AND SUBSTR(entity_id, 1, ?) <> ?
             AND SUBSTR(attribute, 1, ?) <> ?
           GROUP BY tx_id`,
          [
            ...txIds,
            systemEntityPrefixLength,
            TX_ENTITY_PREFIX,
            systemAttributePrefixLength,
            TX_ATTRIBUTE_PREFIX,
          ],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to count transaction assertions: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      for (const row of assertRows) {
        const aggregate = aggregateMap.get(row.tx_id);
        if (aggregate) aggregate.assertCount = Number(row.count);
      }

      const retractRows = yield* adapter
        .rawQuery<CountRow>(
          `SELECT retract_tx_id AS tx_id, COUNT(*) AS count
           FROM triples
           WHERE retract_tx_id IN (${inClause})
             AND SUBSTR(entity_id, 1, ?) <> ?
             AND SUBSTR(attribute, 1, ?) <> ?
           GROUP BY retract_tx_id`,
          [
            ...txIds,
            systemEntityPrefixLength,
            TX_ENTITY_PREFIX,
            systemAttributePrefixLength,
            TX_ATTRIBUTE_PREFIX,
          ],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to count transaction retractions: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      for (const row of retractRows) {
        const aggregate = aggregateMap.get(row.tx_id);
        if (aggregate) aggregate.retractCount = Number(row.count);
      }

      const affectedRows = yield* adapter
        .rawQuery<AffectedEntityRow>(
          `SELECT tx_id, entity_id
           FROM triples
           WHERE tx_id IN (${inClause})
             AND SUBSTR(entity_id, 1, ?) <> ?
             AND SUBSTR(attribute, 1, ?) <> ?
           UNION
           SELECT retract_tx_id AS tx_id, entity_id
           FROM triples
           WHERE retract_tx_id IN (${inClause})
             AND SUBSTR(entity_id, 1, ?) <> ?
             AND SUBSTR(attribute, 1, ?) <> ?`,
          [
            ...txIds,
            systemEntityPrefixLength,
            TX_ENTITY_PREFIX,
            systemAttributePrefixLength,
            TX_ATTRIBUTE_PREFIX,
            ...txIds,
            systemEntityPrefixLength,
            TX_ENTITY_PREFIX,
            systemAttributePrefixLength,
            TX_ATTRIBUTE_PREFIX,
          ],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to read transaction affected entities: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      for (const row of affectedRows) {
        if (!row.tx_id) continue;
        aggregateMap.get(row.tx_id)?.affectedEntities.add(row.entity_id);
      }

      return freezeTransactionAggregates(aggregateMap);
    });

  const current: SnapshotServiceShape["current"] = (entityId) =>
    Effect.gen(function* () {
      const rows = yield* adapter
        .rawQuery<EntitySnapshotRow & { data: string }>(
          `SELECT s.entity_id, s.tx_id, s.hash, s.tx_time, s.entity_type, b.data
           FROM entity_snapshots s
           JOIN entity_blobs b ON b.hash = s.hash
           WHERE s.entity_id = ?
           ORDER BY s.tx_time DESC, s.rowid DESC
           LIMIT 1`,
          [entityId],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to read current snapshot for ${entityId}: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      if (rows.length === 0) return null;
      const row = rows[0]!;
      return buildSnapshot(row, row.data);
    });

  const at: SnapshotServiceShape["at"] = (entityId, txId) =>
    Effect.gen(function* () {
      const rows = yield* adapter
        .rawQuery<EntitySnapshotRow & { data: string }>(
          `SELECT s.entity_id, s.tx_id, s.hash, s.tx_time, s.entity_type, b.data
           FROM entity_snapshots s
           JOIN entity_blobs b ON b.hash = s.hash
           WHERE s.entity_id = ? AND s.tx_id = ?`,
          [entityId, txId],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to read snapshot at ${txId}: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      if (rows.length === 0) return null;
      const row = rows[0]!;
      return buildSnapshot(row, row.data);
    });

  const asOf: SnapshotServiceShape["asOf"] = (entityId, asOfTime) =>
    Effect.gen(function* () {
      const rows = yield* adapter
        .rawQuery<EntitySnapshotRow & { data: string }>(
          `SELECT s.entity_id, s.tx_id, s.hash, s.tx_time, s.entity_type, b.data
           FROM entity_snapshots s
           JOIN entity_blobs b ON b.hash = s.hash
           WHERE s.entity_id = ? AND s.tx_time <= ?
           ORDER BY s.tx_time DESC, s.rowid DESC
           LIMIT 1`,
          [entityId, asOfTime],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to read snapshot asOf ${asOfTime}: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      if (rows.length === 0) return null;
      const row = rows[0]!;
      return buildSnapshot(row, row.data);
    });

  const hashAt: SnapshotServiceShape["hashAt"] = (entityId, txId) =>
    Effect.gen(function* () {
      const rows = yield* adapter
        .rawQuery<{ hash: string }>(
          `SELECT hash FROM entity_snapshots WHERE entity_id = ? AND tx_id = ?`,
          [entityId, txId],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to read hash at ${txId}: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      return rows.length > 0 ? rows[0]!.hash : null;
    });

  const batchCurrent: SnapshotServiceShape["batchCurrent"] = (entityIds) =>
    Effect.gen(function* () {
      if (entityIds.length === 0) return new Map();

      // Use a correlated anti-join to get one deterministic latest row per entity
      const placeholders = entityIds.map(() => "?").join(", ");
      const rows = yield* adapter
        .rawQuery<EntitySnapshotRow & { data: string }>(
          `SELECT s.entity_id, s.tx_id, s.hash, s.tx_time, s.entity_type, b.data
           FROM entity_snapshots s
           JOIN entity_blobs b ON b.hash = s.hash
           WHERE s.entity_id IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM entity_snapshots s2
             WHERE s2.entity_id = s.entity_id
             AND (
               s2.tx_time > s.tx_time
               OR (s2.tx_time = s.tx_time AND s2.tx_id > s.tx_id)
             )
           )`,
          [...entityIds],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to batch read snapshots: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      const result = new Map<string, EntitySnapshot>();
      for (const row of rows) {
        result.set(row.entity_id, buildSnapshot(row, row.data));
      }
      return result;
    });

  const hashes: SnapshotServiceShape["hashes"] = (entityId) =>
    Effect.gen(function* () {
      const rows = yield* adapter
        .rawQuery<{ tx_id: string; tx_time: number; hash: string }>(
          `SELECT tx_id, tx_time, hash FROM entity_snapshots
           WHERE entity_id = ?
           ORDER BY tx_time ASC`,
          [entityId],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to read hash history: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      return rows.map((r) => ({ txId: r.tx_id, txTime: r.tx_time, hash: r.hash }));
    });

  const diff: SnapshotServiceShape["diff"] = (entityId, fromTxId, toTxId) =>
    Effect.gen(function* () {
      const fromSnapshot = yield* at(entityId, fromTxId);
      const toSnapshot = yield* at(entityId, toTxId);

      const fromAttrs = fromSnapshot?.attributes ?? {};
      const toAttrs = toSnapshot?.attributes ?? {};
      const fromHash = fromSnapshot?.hash ?? EMPTY_ENTITY_HASH;
      const toHash = toSnapshot?.hash ?? EMPTY_ENTITY_HASH;

      const { added, removed, changed } = diffAttributes(fromAttrs, toAttrs);

      return {
        entityId,
        fromTxId,
        toTxId,
        fromHash,
        toHash,
        added,
        removed,
        changed,
      };
    });

  const findByHash: SnapshotServiceShape["findByHash"] = (hash) =>
    Effect.gen(function* () {
      // Find entities whose latest snapshot has this hash
      const rows = yield* adapter
        .rawQuery<{ entity_id: string }>(
          `SELECT DISTINCT s.entity_id FROM entity_snapshots s
           WHERE s.hash = ?
           AND NOT EXISTS (
             SELECT 1 FROM entity_snapshots s2
             WHERE s2.entity_id = s.entity_id
             AND (
               s2.tx_time > s.tx_time
               OR (s2.tx_time = s.tx_time AND s2.tx_id > s.tx_id)
             )
           )`,
          [hash],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to find entities by hash: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      return rows.map((r) => r.entity_id);
    });

  const findChanged: SnapshotServiceShape["findChanged"] = (sinceTxId) =>
    Effect.gen(function* () {
      // Find the tx_time of the reference transaction
      const txRows = yield* adapter
        .rawQuery<{ tx_time: number }>(
          `SELECT tx_time FROM entity_snapshots WHERE tx_id = ? LIMIT 1`,
          [sinceTxId],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to look up tx_time for ${sinceTxId}: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      if (txRows.length === 0) {
        // If we can't find the tx, return all current snapshots
        const allRows = yield* adapter
          .rawQuery<{ entity_id: string; hash: string }>(
            `SELECT s.entity_id, s.hash FROM entity_snapshots s
             WHERE NOT EXISTS (
               SELECT 1 FROM entity_snapshots s2
               WHERE s2.entity_id = s.entity_id
               AND (
                 s2.tx_time > s.tx_time
                 OR (s2.tx_time = s.tx_time AND s2.tx_id > s.tx_id)
               )
             )`,
            [],
          )
          .pipe(
            Effect.mapError(
              (e) =>
                new SnapshotError({
                  message: `Failed to find all changed entities: ${String(e)}`,
                  cause: e,
                }),
            ),
          );
        return allRows.map((r) => ({ entityId: r.entity_id, hash: r.hash }));
      }

      const sinceTxTime = txRows[0]!.tx_time;

      // Find entities that have snapshots after the given tx_time
      const rows = yield* adapter
        .rawQuery<{ entity_id: string; hash: string }>(
          `SELECT s.entity_id, s.hash FROM entity_snapshots s
           WHERE (
             s.tx_time > ?
             OR (s.tx_time = ? AND s.tx_id > ?)
           )
           AND NOT EXISTS (
             SELECT 1 FROM entity_snapshots s2
             WHERE s2.entity_id = s.entity_id
             AND (
               s2.tx_time > s.tx_time
               OR (s2.tx_time = s.tx_time AND s2.tx_id > s.tx_id)
             )
           )`,
          [sinceTxTime, sinceTxTime, sinceTxId],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to find changed entities: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      return rows.map((r) => ({ entityId: r.entity_id, hash: r.hash }));
    });

  const checkpoint: SnapshotServiceShape["checkpoint"] = (asOfTime) =>
    Effect.gen(function* () {
      const rows = yield* adapter
        .rawQuery<{ entity_id: string; hash: string }>(
          `SELECT s.entity_id, s.hash FROM entity_snapshots s
           WHERE s.tx_time <= ?
           AND NOT EXISTS (
             SELECT 1 FROM entity_snapshots s2
             WHERE s2.entity_id = s.entity_id
             AND s2.tx_time <= ?
             AND (
               s2.tx_time > s.tx_time
               OR (s2.tx_time = s.tx_time AND s2.tx_id > s.tx_id)
             )
           )`,
          [asOfTime, asOfTime],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to build checkpoint: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      const result = new Map<string, string>();
      for (const row of rows) {
        result.set(row.entity_id, row.hash);
      }
      return result;
    });

  const listTransactions: SnapshotServiceShape["listTransactions"] = (request) =>
    Effect.gen(function* () {
      const limit = clampTransactionLimit(request.limit);
      const cursor = decodeTransactionCursor(request.cursor);
      const whereConditions = ["instant.attribute = ?", "instant.retracted_at IS NULL"];
      const params: unknown[] = [TxAttributes.USER, TxAttributes.INSTANT];

      if (cursor) {
        whereConditions.push(
          `(instant.value_datetime < ? OR (instant.value_datetime = ? AND instant.entity_id < ?))`,
        );
        params.push(cursor.timestamp, cursor.timestamp, cursor.txId);
      }

      params.push(limit + 1);

      const rows = yield* adapter
        .rawQuery<TransactionRow>(
          `SELECT
             instant.entity_id AS tx_id,
             instant.value_datetime AS timestamp,
             tx_user.value_string AS user
           FROM triples instant
           LEFT JOIN triples tx_user
             ON tx_user.entity_id = instant.entity_id
            AND tx_user.attribute = ?
            AND tx_user.retracted_at IS NULL
           WHERE ${whereConditions.join(" AND ")}
           ORDER BY instant.value_datetime DESC, instant.entity_id DESC
           LIMIT ?`,
          params,
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to list transactions: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const aggregates = yield* loadTransactionAggregates(page.map((row) => row.tx_id));
      const totalCount = cursor
        ? undefined
        : yield* adapter
            .rawQuery<TotalCountRow>(
              `SELECT COUNT(*) AS total
               FROM triples
               WHERE attribute = ? AND retracted_at IS NULL`,
              [TxAttributes.INSTANT],
            )
            .pipe(
              Effect.map((countRows) => Number(countRows[0]?.total ?? page.length)),
              Effect.mapError(
                (e) =>
                  new SnapshotError({
                    message: `Failed to count transactions: ${String(e)}`,
                    cause: e,
                  }),
              ),
            );

      const transactions: TransactionSummary[] = page.map((row) => {
        const aggregate = aggregates.get(row.tx_id);
        return {
          txId: row.tx_id,
          timestamp: Number(row.timestamp ?? 0),
          user: row.user,
          assertCount: aggregate?.assertCount ?? 0,
          retractCount: aggregate?.retractCount ?? 0,
          affectedEntities: [...(aggregate?.affectedEntities ?? [])],
        };
      });

      const last = transactions[transactions.length - 1];

      return {
        transactions,
        nextCursor: hasMore && last ? encodeTransactionCursor(last.timestamp, last.txId) : null,
        ...(totalCount !== undefined ? { totalCount } : {}),
      };
    });

  const getTransaction: SnapshotServiceShape["getTransaction"] = (txId) =>
    Effect.gen(function* () {
      const txRows = yield* adapter
        .rawQuery<TransactionRow>(
          `SELECT
             instant.entity_id AS tx_id,
             instant.value_datetime AS timestamp,
             tx_user.value_string AS user
           FROM triples instant
           LEFT JOIN triples tx_user
             ON tx_user.entity_id = instant.entity_id
            AND tx_user.attribute = ?
            AND tx_user.retracted_at IS NULL
           WHERE instant.entity_id = ?
             AND instant.attribute = ?
             AND instant.retracted_at IS NULL
           LIMIT 1`,
          [TxAttributes.USER, txId, TxAttributes.INSTANT],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to read transaction ${txId}: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      const systemEntityPrefixLength = TX_ENTITY_PREFIX.length;
      const systemAttributePrefixLength = TX_ATTRIBUTE_PREFIX.length;

      const assertedRows = yield* adapter
        .rawQuery<ChangedTripleRow>(
          `SELECT entity_id, attribute
           FROM triples
           WHERE tx_id = ?
             AND SUBSTR(entity_id, 1, ?) <> ?
             AND SUBSTR(attribute, 1, ?) <> ?`,
          [
            txId,
            systemEntityPrefixLength,
            TX_ENTITY_PREFIX,
            systemAttributePrefixLength,
            TX_ATTRIBUTE_PREFIX,
          ],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to read assertions for transaction ${txId}: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      const retractedRows = yield* adapter
        .rawQuery<ChangedTripleRow>(
          `SELECT entity_id, attribute
           FROM triples
           WHERE retract_tx_id = ?
             AND SUBSTR(entity_id, 1, ?) <> ?
             AND SUBSTR(attribute, 1, ?) <> ?`,
          [
            txId,
            systemEntityPrefixLength,
            TX_ENTITY_PREFIX,
            systemAttributePrefixLength,
            TX_ATTRIBUTE_PREFIX,
          ],
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new SnapshotError({
                message: `Failed to read retractions for transaction ${txId}: ${String(e)}`,
                cause: e,
              }),
          ),
        );

      const entityIds = [
        ...new Set([...assertedRows, ...retractedRows].map((row) => row.entity_id)),
      ].sort();

      const entities = yield* Effect.all(
        entityIds.map((entityId) =>
          Effect.gen(function* () {
            const snap = yield* at(entityId, txId).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            );
            let snapshot: EntitySnapshotResponse | null = null;
            let previousHash: string | null = null;

            if (snap) {
              snapshot = {
                entityId: snap.entityId,
                entityType: snap.entityType,
                attributes: snap.attributes as Record<string, unknown>,
                hash: snap.hash,
                txId: snap.txId,
                txTime: snap.txTime,
              };

              const history = yield* hashes(entityId).pipe(
                Effect.catchAll(() =>
                  Effect.succeed(
                    [] as ReadonlyArray<{ txId: string; txTime: number; hash: string }>,
                  ),
                ),
              );
              const currentIndex = history.findIndex((entry) => entry.txId === txId);
              if (currentIndex > 0) {
                previousHash = history[currentIndex - 1]!.hash;
              }
            }

            return {
              entityId,
              entityType: snapshot?.entityType ?? null,
              snapshot,
              previousHash,
            };
          }),
        ),
        { concurrency: 5 },
      );

      const row = txRows[0];
      return {
        txId,
        timestamp: Number(row?.timestamp ?? 0),
        user: row?.user ?? null,
        assertCount: assertedRows.length,
        retractCount: retractedRows.length,
        entities,
      } satisfies TransactionDetailResponse;
    });

  return {
    current,
    at,
    asOf,
    hashAt,
    batchCurrent,
    hashes,
    diff,
    findByHash,
    findChanged,
    checkpoint,
    listTransactions,
    getTransaction,
  } satisfies SnapshotServiceShape;
});

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export const SnapshotWriterLive = Layer.effect(SnapshotWriter, makeSnapshotWriter);

export const SnapshotServiceLive = Layer.effect(SnapshotService, makeSnapshotService);
