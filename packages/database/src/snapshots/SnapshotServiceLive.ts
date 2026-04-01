/**
 * SnapshotService + SnapshotWriter implementation
 *
 * Uses the StorageAdapter's rawQuery for snapshot-specific SQL operations.
 * All snapshot reads/writes go through the same database connection as the triple store.
 */

import { Clock, Effect, Layer, Option } from "effect";
import { StorageAdapter } from "../storage/StorageAdapter.js";
import { TripleStore } from "../store/TripleStore.js";
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
import type { EntityId } from "@open-ontology/database";

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
  } satisfies SnapshotServiceShape;
});

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export const SnapshotWriterLive = Layer.effect(SnapshotWriter, makeSnapshotWriter);

export const SnapshotServiceLive = Layer.effect(SnapshotService, makeSnapshotService);
