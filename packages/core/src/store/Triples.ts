/**
 * Triples — the one service of the triple store.
 *
 * Writes, triple-pattern reads, and Datalog queries share one coherent service:
 *
 * ```ts
 * yield* triples.assert({ entityId: "p1", attribute: ":name", value: { type: "string", value: "Alice" } })
 * const facts = yield* triples.match({ entityId: "p1" })              // triple pattern read
 * const { results } = yield* triples.query({ find: ["?n"], where: [["?p", ":name", "?n"]] }) // datalog read
 * ```
 *
 * `Sparql`, `SnapshotService`, `SubscriptionManager`, and `DatabaseManager`
 * remain separate optional services — they have genuinely independent consumers.
 */

import { Context, Effect } from "effect";
import type { Triple, TripleInput, TripleId, EntityId, TransactOp } from "../Triple.js";
import type { Pattern } from "../types/Pattern.js";
import type { QueryState } from "../types/QueryBuilder.js";
import type { WriteError, ReadError, QueryError, DatalogError } from "../errors/index.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import type {
  QueryResult,
  QueryDebugInfo,
  QueryPlan,
  QueryMetrics,
  WrappedQueryResult,
} from "../storage/QueryExecutor.js";

// =============================================================================
// Result / options types (canonical home)
// =============================================================================

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

/**
 * Options accepted by the Datalog read methods.
 */
export interface QueryOptions {
  /** Include debug metrics (generated SQL, timings, plan) in the response. */
  readonly debug?: boolean;
}

/**
 * Response from a Datalog `query`: result bindings plus optional debug info.
 */
export interface QueryResponse {
  readonly results: QueryResult;
  readonly debug?: QueryDebugInfo;
}

/**
 * Response from a paged Datalog query (`queryPage`): result bindings, optional
 * total count, and a cursor for the next page.
 */
export type PagedQueryResponse = WrappedQueryResult;

/**
 * Result of explaining a query (compile without executing).
 */
export interface ExplainResult {
  readonly queryPlan: QueryPlan;
  readonly metrics?: QueryMetrics;
}

// =============================================================================
// Service shape
// =============================================================================

export interface TriplesService {
  // --- Writes (append-only semantics) --------------------------------------
  readonly assert: (input: TripleInput) => Effect.Effect<Triple, WriteError>;
  readonly assertBatch: (
    inputs: readonly TripleInput[],
    options?: BulkInsertOptions,
  ) => Effect.Effect<readonly Triple[], WriteError>;
  readonly retract: (id: TripleId) => Effect.Effect<void, WriteError>;
  readonly retractByPattern: (pattern: Pattern) => Effect.Effect<number, WriteError | ReadError>;
  /** Group operations into a single atomic transaction with metadata. */
  readonly transact: (
    operations: readonly TransactOp[],
    meta?: TransactionMeta,
  ) => Effect.Effect<TransactionResult, WriteError | ReadError>;
  /** Wrap an arbitrary effect in a database transaction (no-op on KV backends). */
  readonly withTransaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | WriteError>;

  // --- Triple-level reads --------------------------------------------------
  /** Fetch a single triple by id. */
  readonly get: (id: TripleId) => Effect.Effect<Triple | null, ReadError>;
  /** Fetch all live triples for an entity. */
  readonly entity: (entityId: EntityId) => Effect.Effect<readonly Triple[], ReadError>;
  /** Match triples against a pattern. */
  readonly match: (pattern: Pattern) => Effect.Effect<readonly Triple[], ReadError>;
  /** Match triples as of a point in time. */
  readonly matchAsOf: (
    pattern: Pattern,
    asOf: number,
  ) => Effect.Effect<readonly Triple[], ReadError>;
  /** Full history (including retracted) for an entity. */
  readonly history: (entityId: EntityId) => Effect.Effect<readonly Triple[], ReadError>;

  // --- Datalog reads -------------------------------------------------------
  /** Execute a Datalog query. */
  readonly query: (
    query: DatalogQuery,
    options?: QueryOptions,
  ) => Effect.Effect<QueryResponse, ReadError | DatalogError>;
  /** Execute a wrapped/paginated Datalog query. */
  readonly queryPage: (
    query: WrappedQuery,
    options?: QueryOptions,
  ) => Effect.Effect<PagedQueryResponse, ReadError | DatalogError>;
  /** Explain a Datalog query without executing it. */
  readonly explain: (query: DatalogQuery) => Effect.Effect<ExplainResult, DatalogError>;
  /** Explain a wrapped Datalog query without executing it. */
  readonly explainPage: (query: WrappedQuery) => Effect.Effect<ExplainResult, DatalogError>;

  // --- Fluent-builder execution -------------------------------------------
  /** Execute a `Query.from(...)` builder state, returning whole entities. */
  readonly entities: (
    state: QueryState,
  ) => Effect.Effect<readonly Triple[], ReadError | QueryError>;
}

/**
 * The `Triples` service tag.
 *
 * Namespaced so the bare id can't collide with another library's tag when they
 * share an Effect context.
 */
export class Triples extends Context.Service<Triples, TriplesService>()("triplex/Triples") {}
