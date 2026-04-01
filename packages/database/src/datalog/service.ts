/**
 * Datalog service definition
 */

import { Context, Effect } from "effect";
import type { DatalogQuery, QueryResult, WrappedQuery } from "./types.js";
import type { QueryMetrics } from "./compiler.js";
import type { ReadError, DatalogError, DatalogValidationError } from "../errors/index.js";
// NOTE: typeCheck was removed from DatalogService — it's a compiler/tooling
// concern that depends on HM types. See @open-ontology/core for the type checker.

/**
 * Backend-agnostic query plan
 */
export interface QueryPlan {
  backend: string;
  steps: Array<{ label: string; query: string; params?: unknown[] }>;
}

/**
 * Debug information returned with query results when debug mode is enabled
 */
export interface QueryDebugInfo {
  metrics: QueryMetrics;
  executionTimeMs: number;
  resultCount: number;
  generatedSql: string;
  params: unknown[];
  queryPlan?: QueryPlan;
}

/**
 * Result of a wrapped query with pagination info
 */
export interface WrappedQueryResult {
  results: QueryResult;
  totalCount?: number;
  /** Cursor for the next page (if more results available) */
  nextCursor?: string;
  debug?: QueryDebugInfo;
}

/**
 * DatalogService interface
 *
 * Provides a high-level API for executing Datalog queries against the TripleStore.
 */
export interface DatalogService {
  /**
   * Execute a Datalog query
   *
   * The query is validated using Effect Schema before execution.
   *
   * @param query - The Datalog query to execute (will be validated)
   * @param debug - Whether to include debug metrics in the response
   * @returns Object with results array and optional debug info
   *
   * @example
   * ```typescript
   * const { results } = yield* Datalog.query({
   *   find: ["?name", "?age"],
   *   where: [
   *     ["?person", ":name", "?name"],
   *     ["?person", ":age", "?age"],
   *     [">=", "?age", 18]
   *   ]
   * })
   * // Returns: { results: [{ "?name": "Alice", "?age": 30 }, ...] }
   *
   * // With debug mode:
   * const { results, debug } = yield* Datalog.query(query, true)
   * // debug includes metrics, timing, generated SQL, etc.
   * ```
   */
  readonly query: (
    query: unknown,
    debug?: boolean,
  ) => Effect.Effect<
    { results: QueryResult; debug?: QueryDebugInfo },
    ReadError | DatalogError | DatalogValidationError
  >;

  /**
   * Execute a pre-validated Datalog query
   *
   * Use this when you've already validated the query structure
   * and want to skip re-validation for performance.
   *
   * @param query - A validated DatalogQuery object
   * @param debug - Whether to include debug metrics in the response
   * @returns Object with results array and optional debug info
   */
  readonly queryValidated: (
    query: DatalogQuery,
    debug?: boolean,
  ) => Effect.Effect<{ results: QueryResult; debug?: QueryDebugInfo }, ReadError | DatalogError>;

  /**
   * Execute a wrapped query with subquery semantics
   *
   * Wraps an inner query in a CTE, allowing additional filtering and
   * cursor-based pagination on top of the inner query's results. This is useful for:
   * - Paginating results from a query that has its own limit
   * - Filtering on result columns (like a WHERE on a subquery)
   * - Getting total count for pagination UI
   * - Efficient keyset pagination (cursor-based) for large datasets
   *
   * @param query - The wrapped query specification
   * @param debug - Whether to include debug metrics in the response
   * @returns Results with optional total count and nextCursor for pagination
   *
   * @example
   * ```typescript
   * // First page
   * const { results, totalCount, nextCursor } = yield* Datalog.queryWrapped({
   *   inner: {
   *     find: ["?name", "?age"],
   *     where: [["?p", ":name", "?name"], ["?p", ":age", "?age"]],
   *     limit: 1000
   *   },
   *   orderBy: [{ variable: "?name", direction: "asc" }],
   *   filters: [{ column: "?name", op: "ilike", value: "%smith%" }],
   *   limit: 20,
   *   includeCount: true
   * })
   *
   * // Next page (using cursor)
   * const page2 = yield* Datalog.queryWrapped({
   *   inner: { ... },
   *   orderBy: [{ variable: "?name", direction: "asc" }],
   *   limit: 20,
   *   cursor: nextCursor
   * })
   * ```
   */
  readonly queryWrapped: (
    query: WrappedQuery,
    debug?: boolean,
  ) => Effect.Effect<WrappedQueryResult, ReadError | DatalogError>;

  /**
   * Explain a Datalog query: compile and return the query plan without executing.
   *
   * @param query - The Datalog query to explain (will be validated)
   * @returns The query plan and optional compilation metrics
   */
  readonly explain: (
    query: unknown,
  ) => Effect.Effect<
    { queryPlan: QueryPlan; metrics?: QueryMetrics },
    DatalogError | DatalogValidationError
  >;

  /**
   * Explain a wrapped Datalog query: compile and return the query plan without executing.
   *
   * @param query - The wrapped query to explain (will be validated)
   * @returns The query plan (may include multiple steps for main + count queries)
   */
  readonly explainWrapped: (
    query: unknown,
  ) => Effect.Effect<{ queryPlan: QueryPlan }, DatalogError | DatalogValidationError>;
}

/**
 * Datalog service tag for dependency injection
 */
export class Datalog extends Context.Tag("Datalog")<Datalog, DatalogService>() {}
