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
 * `SnapshotService`, `SubscriptionManager`, and `DatabaseManager`
 * remain separate optional services — they have genuinely independent consumers.
 */

import { Context, Effect } from "effect";
import type {
  Triple,
  TripleInput,
  TripleId,
  EntityId,
  TransactOp,
  TransactionPrecondition,
} from "../Triple.js";
import type { Pattern } from "../types/Pattern.js";
import type {
  WriteError,
  ReadError,
  DatalogError,
  CommandAlreadyCommittedError,
  TransactionConflictError,
  PaginationCursorError,
} from "../errors/index.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import type { TemporalBasis } from "../Temporal.js";
import type { TripleValue } from "../Value.js";
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
  readonly position: number;
  readonly instant: number;
  readonly triples: readonly Triple[];
  readonly retracted: number;
}

/**
 * Transaction metadata options
 */
export interface TransactionMeta {
  readonly actor?: string;
  /** Atomically unique idempotency identity within this Triplex database. */
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly configSnapshot?: string;
  /**
   * Compare-and-retract conditions. Every referenced triple must also have a
   * `retract` operation in this transaction. If another writer retracts it
   * first, the whole transaction fails with `TransactionConflictError`.
   */
  readonly preconditions?: readonly TransactionPrecondition[];
}

export interface TransactionChange {
  readonly op: "assert" | "retract";
  readonly tripleId: string;
  readonly entityId: string;
  readonly attribute: string;
  /** Present on journals written by the bitemporal journal format. */
  readonly entityType?: string;
  /** The complete typed value, retained for assertions and retractions. */
  readonly value?: TripleValue;
  readonly validFrom?: number;
  readonly validTo?: number;
  readonly recordedAt?: number;
  readonly retractedAt?: number;
  readonly assertionTxId?: string;
  readonly retractionTxId?: string;
}

export interface TransactionRecord {
  readonly txId: string;
  readonly position: number;
  readonly instant: number;
  readonly actor?: string;
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly configSnapshot?: string;
  readonly changes: readonly TransactionChange[];
}

export interface TransactionPageRequest {
  /** Return transactions strictly after this commit position. Defaults to 0. */
  readonly after?: number;
  /** Maximum number of transactions to return. Defaults to 100; maximum 1,000. */
  readonly limit?: number;
}

export interface TransactionPage {
  readonly transactions: readonly TransactionRecord[];
  /** Position of the final returned transaction, suitable for the next `after`. */
  readonly next?: number;
}

/**
 * Options accepted by the Datalog read methods.
 */
export interface QueryOptions {
  /** Include debug metrics (generated SQL, timings, plan) in the response. */
  readonly debug?: boolean;
  /** Evaluate the complete query against one bitemporal basis. */
  readonly basis?: TemporalBasis;
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
  ) => Effect.Effect<readonly Triple[], WriteError>;
  readonly retract: (id: TripleId) => Effect.Effect<void, WriteError>;
  readonly retractByPattern: (pattern: Pattern) => Effect.Effect<number, WriteError | ReadError>;
  /** Group operations into a single atomic transaction with metadata. */
  readonly transact: (
    operations: readonly TransactOp[],
    meta?: TransactionMeta,
  ) => Effect.Effect<
    TransactionResult,
    WriteError | ReadError | TransactionConflictError | CommandAlreadyCommittedError
  >;
  // --- Triple-level reads --------------------------------------------------
  /** Fetch a single triple by id. */
  readonly get: (id: TripleId) => Effect.Effect<Triple | null, ReadError>;
  /** Fetch all live triples for an entity. */
  readonly entity: (
    entityId: EntityId,
    basis?: TemporalBasis,
  ) => Effect.Effect<readonly Triple[], ReadError>;
  /** Batch entity materialization, preserving input order and missing entries. */
  readonly entities: (
    entityIds: readonly EntityId[],
    basis?: TemporalBasis,
  ) => Effect.Effect<readonly (readonly Triple[])[], ReadError>;
  /** Match triples against a pattern. */
  readonly match: (
    pattern: Pattern,
    basis?: TemporalBasis,
  ) => Effect.Effect<readonly Triple[], ReadError>;
  /** Full history (including retracted) for an entity. */
  readonly history: (entityId: EntityId) => Effect.Effect<readonly Triple[], ReadError>;
  /** Read a persisted causal transaction envelope and its fact changes. */
  readonly transaction: (txId: string) => Effect.Effect<TransactionRecord | null, ReadError>;
  /** Lookup the durable receipt for an atomically unique command ID. */
  readonly transactionByCommand: (
    commandId: string,
  ) => Effect.Effect<TransactionRecord | null, ReadError>;
  /** Read ordered transaction envelopes after a durable resume position. */
  readonly transactions: (
    request?: TransactionPageRequest,
  ) => Effect.Effect<TransactionPage, ReadError>;
  /** Latest committed backend position, including internal maintenance writes. */
  readonly currentPosition: () => Effect.Effect<number, ReadError>;

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
  ) => Effect.Effect<PagedQueryResponse, ReadError | DatalogError | PaginationCursorError>;
  /** Explain a Datalog query without executing it. */
  readonly explain: (query: DatalogQuery) => Effect.Effect<ExplainResult, DatalogError>;
  /** Explain a wrapped Datalog query without executing it. */
  readonly explainPage: (query: WrappedQuery) => Effect.Effect<ExplainResult, DatalogError>;
}

/**
 * The `Triples` service tag.
 *
 * Namespaced so the bare id can't collide with another library's tag when they
 * share an Effect context.
 */
export class Triples extends Context.Service<Triples, TriplesService>()("triplex/Triples") {}
