/**
 * Entity Snapshot Service
 *
 * Provides content-addressed JSON snapshots of entities for:
 * - O(1) entity reads (single row lookup vs N triple scans)
 * - O(1) change detection (hash comparison)
 * - Structural sharing (identical entity states share blobs)
 * - Efficient checkpoints (entity→hash maps)
 */

import { Context, Data, Effect } from "effect";
import type { EntitySnapshot, EntityDiff } from "./canonical.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SnapshotError extends Data.TaggedError("SnapshotError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Service Interface
// ---------------------------------------------------------------------------

export interface SnapshotServiceShape {
  // Read
  readonly current: (entityId: string) => Effect.Effect<EntitySnapshot | null, SnapshotError>;

  readonly at: (
    entityId: string,
    txId: string,
  ) => Effect.Effect<EntitySnapshot | null, SnapshotError>;

  readonly asOf: (
    entityId: string,
    asOf: number,
  ) => Effect.Effect<EntitySnapshot | null, SnapshotError>;

  readonly hashAt: (entityId: string, txId: string) => Effect.Effect<string | null, SnapshotError>;

  readonly batchCurrent: (
    entityIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, EntitySnapshot>, SnapshotError>;

  // History
  readonly hashes: (
    entityId: string,
  ) => Effect.Effect<ReadonlyArray<{ txId: string; txTime: number; hash: string }>, SnapshotError>;

  readonly diff: (
    entityId: string,
    fromTxId: string,
    toTxId: string,
  ) => Effect.Effect<EntityDiff, SnapshotError>;

  // Structural queries
  readonly findByHash: (hash: string) => Effect.Effect<ReadonlyArray<string>, SnapshotError>;

  readonly findChanged: (
    sinceTxId: string,
  ) => Effect.Effect<ReadonlyArray<{ entityId: string; hash: string }>, SnapshotError>;

  // Checkpoint support
  readonly checkpoint: (asOf: number) => Effect.Effect<ReadonlyMap<string, string>, SnapshotError>;
}

// ---------------------------------------------------------------------------
// Writer Interface (internal — called within transactions)
// ---------------------------------------------------------------------------

export interface SnapshotWriterShape {
  /**
   * Materialize snapshots for the given entities within the current transaction.
   * Called synchronously inside the database transaction.
   */
  readonly materialize: (
    txId: string,
    txTime: number,
    changedEntityIds: readonly string[],
  ) => Effect.Effect<ReadonlyArray<EntitySnapshot>, SnapshotError>;

  /**
   * Backfill snapshots for all entities that don't have one yet.
   */
  readonly backfill: () => Effect.Effect<number, SnapshotError>;
}

// ---------------------------------------------------------------------------
// Service Tags
// ---------------------------------------------------------------------------

export class SnapshotService extends Context.Tag("SnapshotService")<
  SnapshotService,
  SnapshotServiceShape
>() {}

export class SnapshotWriter extends Context.Tag("SnapshotWriter")<
  SnapshotWriter,
  SnapshotWriterShape
>() {}
