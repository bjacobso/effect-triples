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
import type { ContentId } from "../content/ContentId.js";
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

  readonly hashAt: (
    entityId: string,
    txId: string,
  ) => Effect.Effect<ContentId | null, SnapshotError>;

  readonly batchCurrent: (
    entityIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, EntitySnapshot>, SnapshotError>;

  // History
  readonly hashes: (
    entityId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ txId: string; txTime: number; hash: ContentId }>,
    SnapshotError
  >;

  readonly diff: (
    entityId: string,
    fromTxId: string,
    toTxId: string,
  ) => Effect.Effect<EntityDiff, SnapshotError>;

  // Structural queries
  readonly findByHash: (hash: ContentId) => Effect.Effect<ReadonlyArray<string>, SnapshotError>;

  readonly findChanged: (
    sinceTxId: string,
  ) => Effect.Effect<ReadonlyArray<{ entityId: string; hash: ContentId }>, SnapshotError>;

  // Checkpoint support
  readonly checkpoint: (asOf: number) => Effect.Effect<ReadonlyMap<string, string>, SnapshotError>;
}

// ---------------------------------------------------------------------------
// Writer Interface (internal — called within transactions)
// ---------------------------------------------------------------------------

export interface SnapshotWriterShape {
  /**
   * Materialize a derived snapshot at the supplied transaction time.
   *
   * This is a post-commit projection. Implementations must reconstruct the
   * entity at `txId`'s ordered commit position (falling back to `txTime` only
   * for an unjournaled source), so a later writer cannot be mislabeled as part
   * of this snapshot.
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

export class SnapshotService extends Context.Service<SnapshotService, SnapshotServiceShape>()(
  "triplex/SnapshotService",
) {}

export class SnapshotWriter extends Context.Service<SnapshotWriter, SnapshotWriterShape>()(
  "triplex/SnapshotWriter",
) {}
