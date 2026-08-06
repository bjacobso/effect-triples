import { Context, Effect } from "effect";
import type { Triple, TripleInput, TripleId, EntityId, TransactOp } from "../Triple.js";
import type { Pattern } from "../types/Pattern.js";
import type { QueryState } from "../types/QueryBuilder.js";
import type { WriteError, ReadError, QueryError } from "../errors/index.js";

/**
 * Transaction result containing the transaction ID, asserted triples, and retraction count
 */
export interface TransactionResult {
  readonly txId: string;
  readonly triples: readonly Triple[];
  readonly retracted: number;
}

/**
 * Transaction metadata options
 */
export interface TransactionMeta {
  readonly user?: string;
}

/**
 * Options for bulk insert operations to optimize performance.
 * These options trade safety for speed and should only be used for initial imports.
 */
export interface BulkInsertOptions {
  /**
   * Drop indexes before bulk insert and recreate them after.
   * Provides 3-5x speedup for large imports (10k+ triples).
   * Database queries will be slow during the import.
   * Default: false
   */
  readonly dropIndexes?: boolean;

  /**
   * Use unsafe PRAGMA settings for maximum speed.
   * WARNING: Data may be lost if the process crashes during import.
   * Only use for imports where data can be re-imported if lost.
   * Default: false
   */
  readonly unsafeMode?: boolean;
}

// TripleStore service shape
export interface TripleStoreService {
  // Write operations (append-only semantics)
  readonly assert: (input: TripleInput) => Effect.Effect<Triple, WriteError>;
  readonly assertBatch: (
    inputs: readonly TripleInput[],
    options?: BulkInsertOptions,
  ) => Effect.Effect<readonly Triple[], WriteError>;
  readonly retract: (id: TripleId) => Effect.Effect<void, WriteError>;
  readonly retractByPattern: (pattern: Pattern) => Effect.Effect<number, WriteError | ReadError>;

  // Transactional write - groups operations into a single atomic transaction with metadata
  readonly transact: (
    operations: readonly TransactOp[],
    meta?: TransactionMeta,
  ) => Effect.Effect<TransactionResult, WriteError | ReadError>;

  // Read operations
  readonly getTriple: (id: TripleId) => Effect.Effect<Triple | null, ReadError>;
  readonly getEntity: (entityId: EntityId) => Effect.Effect<readonly Triple[], ReadError>;
  readonly query: (pattern: Pattern) => Effect.Effect<readonly Triple[], ReadError>;

  // Time travel
  readonly queryAsOf: (
    pattern: Pattern,
    asOf: number,
  ) => Effect.Effect<readonly Triple[], ReadError>;
  readonly history: (entityId: EntityId) => Effect.Effect<readonly Triple[], ReadError>;

  // Query builder support
  readonly queryWithBuilder: (
    state: QueryState,
  ) => Effect.Effect<readonly Triple[], ReadError | QueryError>;

  // Transaction scope - wraps an arbitrary effect in a database transaction
  readonly withTransaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | WriteError>;
}

// Service tag for dependency injection
export class TripleStore extends Context.Tag("TripleStore")<TripleStore, TripleStoreService>() {}
