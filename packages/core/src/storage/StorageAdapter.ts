/**
 * StorageAdapter - Backend-agnostic storage interface
 *
 * Abstracts low-level storage operations allowing different backends
 * (SQLite, PostgreSQL, Cloudflare DO, FoundationDB, etc.) to use
 * their optimal primitives.
 */

import { Context, Effect } from "effect";
import type { TripleInput, TripleRow, QueryPattern } from "./types.js";
import type { ResolvedTemporalBasis } from "../Temporal.js";
import { WriteError, ReadError, MigrationError } from "../errors/index.js";

/**
 * StorageAdapterService - Backend-agnostic storage primitives
 */
export interface StorageAdapterService {
  readonly withTransaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | WriteError>;
  /** Allocate the next ordered commit position inside the current transaction. */
  readonly nextCommitPosition: () => Effect.Effect<number, WriteError>;
  readonly insert: (
    input: TripleInput,
    txId: string | null,
    timestamp: number,
    id: string,
  ) => Effect.Effect<TripleRow, WriteError>;
  readonly batchInsert: (
    inputs: readonly TripleInput[],
    txId: string,
    timestamp: number,
    ids: readonly string[],
  ) => Effect.Effect<readonly TripleRow[], WriteError>;
  readonly retract: (
    id: string,
    timestamp: number,
    txId?: string,
  ) => Effect.Effect<boolean, WriteError>;
  readonly getById: (id: string) => Effect.Effect<TripleRow | null, ReadError>;
  readonly getByEntity: (
    entityId: string,
    basis?: ResolvedTemporalBasis,
  ) => Effect.Effect<readonly TripleRow[], ReadError>;
  readonly getByEntities: (
    entityIds: readonly string[],
    basis?: ResolvedTemporalBasis,
  ) => Effect.Effect<ReadonlyMap<string, readonly TripleRow[]>, ReadError>;
  readonly query: (
    pattern: QueryPattern,
    basis?: ResolvedTemporalBasis,
  ) => Effect.Effect<readonly TripleRow[], ReadError>;
  readonly queryAsOf: (
    pattern: QueryPattern,
    asOf: number,
  ) => Effect.Effect<readonly TripleRow[], ReadError>;
  readonly history: (entityId: string) => Effect.Effect<readonly TripleRow[], ReadError>;
  readonly rawQuery: <T extends object>(
    sql: string,
    params: readonly unknown[],
  ) => Effect.Effect<readonly T[], ReadError>;
  readonly initialize: () => Effect.Effect<void, MigrationError>;
  readonly close: () => Effect.Effect<void, unknown>;
}

/**
 * StorageAdapter service tag for dependency injection
 */
export class StorageAdapter extends Context.Service<StorageAdapter, StorageAdapterService>()(
  "StorageAdapter",
) {}
