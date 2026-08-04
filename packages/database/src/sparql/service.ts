/**
 * SPARQL service definition
 */

import { Context, Effect } from "effect";
import type { SparqlQuery, QueryResult, SelectResult } from "./types.js";
import type { QueryMetrics } from "./compiler.js";
import type { ReadError, SparqlError, SparqlValidationError } from "../errors/index.js";

/**
 * Debug information returned with query results when debug mode is enabled
 */
export interface QueryDebugInfo {
  metrics: QueryMetrics;
  executionTimeMs: number;
  resultCount: number;
  generatedSql: string;
  params: unknown[];
}

/**
 * SparqlService interface
 *
 * Provides a high-level API for executing SPARQL queries against the TripleStore.
 */
export interface SparqlService {
  /**
   * Execute a SPARQL query
   *
   * The query is validated using Effect Schema before execution.
   *
   * @param query - The SPARQL query to execute (will be validated)
   * @param debug - Whether to include debug metrics in the response
   * @returns Object with results and optional debug info
   *
   * @example
   * ```typescript
   * const { results } = yield* Sparql.query({
   *   form: "select",
   *   select: { variables: ["?name", "?email"] },
   *   where: [
   *     ["?person", ":name", "?name"],
   *     { optional: [["?person", ":email", "?email"]] }
   *   ]
   * })
   * // Returns: { type: "select", results: [{ "?name": "Alice", "?email": "alice@example.com" }, ...] }
   *
   * // With debug mode:
   * const { results, debug } = yield* Sparql.query(query, true)
   * // debug includes metrics, timing, generated SQL, etc.
   * ```
   */
  readonly query: (
    query: unknown,
    debug?: boolean,
  ) => Effect.Effect<
    { results: QueryResult; debug?: QueryDebugInfo },
    ReadError | SparqlError | SparqlValidationError
  >;

  /**
   * Execute a pre-validated SPARQL query
   *
   * Use this when you've already validated the query structure
   * and want to skip re-validation for performance.
   *
   * @param query - A validated SparqlQuery object
   * @param debug - Whether to include debug metrics in the response
   * @returns Object with results and optional debug info
   */
  readonly queryValidated: (
    query: SparqlQuery,
    debug?: boolean,
  ) => Effect.Effect<{ results: QueryResult; debug?: QueryDebugInfo }, ReadError | SparqlError>;

  /**
   * Execute a SELECT query and return just the bindings
   *
   * Convenience method for SELECT queries that returns the results directly.
   *
   * @param query - The SPARQL SELECT query
   * @returns Array of variable bindings
   */
  readonly select: (
    query: unknown,
  ) => Effect.Effect<SelectResult, ReadError | SparqlError | SparqlValidationError>;

  /**
   * Execute an ASK query and return the boolean result
   *
   * @param query - The SPARQL ASK query
   * @returns Boolean result
   */
  readonly ask: (
    query: unknown,
  ) => Effect.Effect<boolean, ReadError | SparqlError | SparqlValidationError>;
}

/**
 * Sparql service tag for dependency injection
 */
export class Sparql extends Context.Tag("Sparql")<Sparql, SparqlService>() {}
