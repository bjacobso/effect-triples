/**
 * Datalog SQL layer implementation
 *
 * Connects the Datalog query engine to the QueryExecutor service.
 * The QueryExecutor abstraction allows both SQL-based and KV-based
 * backends to execute Datalog queries.
 */

import { Effect, Layer, Schema } from "effect";
import {
  TripleStore,
  Datalog,
  type DatalogService,
  QueryExecutor,
  CurrentDialect,
  SqliteDialect,
  DatalogQuery,
  WrappedQuery,
  compileWrapped,
  type CompiledWrappedQuery,
  type QueryMetrics,
  DatalogValidationError,
  DatalogError,
  ReadError,
} from "@open-ontology/database";
import type {
  QueryPlan,
  QueryDebugInfo,
  WrappedQueryResult,
  QueryResult,
} from "@open-ontology/database";

// =============================================================================
// Layer Implementation
// =============================================================================

/**
 * DatalogLive layer
 *
 * Provides the Datalog service using QueryExecutor for query execution.
 * Requires both TripleStore and QueryExecutor services.
 *
 * For SQL backends: use SqlQueryExecutorLive which compiles Datalog -> SQL.
 * For KV backends: use the KV-specific executor from kv/.
 */
export const DatalogLive = Layer.effect(
  Datalog,
  Effect.gen(function* () {
    const executor = yield* QueryExecutor;
    // TripleStore is still required for type-check (reads entity type schemas)
    yield* TripleStore;

    // Resolve dialect from context (optional -- defaults to SQLite)
    const dialectOpt = yield* Effect.serviceOption(CurrentDialect);
    const dialect = dialectOpt._tag === "Some" ? dialectOpt.value : SqliteDialect;

    /**
     * Execute a Datalog query with validation
     */
    const query = (rawQuery: unknown, debug = false) =>
      Effect.gen(function* () {
        // 1. Validate query with Effect Schema
        const parseResult = Schema.decodeUnknownEither(DatalogQuery)(rawQuery);

        if (parseResult._tag === "Left") {
          return yield* Effect.fail(
            new DatalogValidationError({
              message: `Invalid Datalog query: ${parseResult.left.message}`,
              query: rawQuery,
              cause: parseResult.left,
            }),
          );
        }

        // 2. Delegate to QueryExecutor (pass validated query to avoid double validation)
        const result = yield* executor.execute(parseResult.right, debug).pipe(
          Effect.mapError(
            (error) =>
              new ReadError({
                message: error.message,
                cause: error.cause,
              }),
          ),
        );

        if (debug && result.debug) {
          return {
            results: result.results as QueryResult,
            debug: result.debug as QueryDebugInfo,
          };
        }

        return { results: result.results as QueryResult };
      }).pipe(Effect.withSpan("datalog.query"));

    /**
     * Execute a pre-validated Datalog query (skip validation)
     */
    const queryValidated = (q: typeof DatalogQuery.Type, debug = false) =>
      Effect.gen(function* () {
        // Prefer executeValidated() to avoid duplicate schema decode when supported.
        const run = executor.executeValidated
          ? executor.executeValidated(q, debug)
          : executor.execute(q, debug);

        const result = yield* run.pipe(
          Effect.mapError(
            (error) =>
              new ReadError({
                message: error.message,
                cause: error.cause,
              }),
          ),
        );

        if (debug && result.debug) {
          return {
            results: result.results as QueryResult,
            debug: result.debug as QueryDebugInfo,
          };
        }

        return { results: result.results as QueryResult };
      });

    /**
     * Execute a wrapped query with subquery semantics
     */
    const queryWrapped = (q: typeof WrappedQuery.Type, debug = false) =>
      Effect.gen(function* () {
        const result = yield* executor.executeWrapped(q, debug).pipe(
          Effect.mapError(
            (error) =>
              new ReadError({
                message: error.message,
                cause: error.cause,
              }),
          ),
        );

        return result as WrappedQueryResult;
      }).pipe(Effect.withSpan("datalog.queryWrapped"));

    /**
     * Explain a Datalog query: compile and return the query plan without executing
     */
    const explain = (rawQuery: unknown) =>
      Effect.gen(function* () {
        const parseResult = Schema.decodeUnknownEither(DatalogQuery)(rawQuery);
        if (parseResult._tag === "Left") {
          return yield* Effect.fail(
            new DatalogValidationError({
              message: `Invalid Datalog query: ${parseResult.left.message}`,
              query: rawQuery,
              cause: parseResult.left,
            }),
          );
        }

        const result = yield* executor.explain(parseResult.right).pipe(
          Effect.mapError(
            (error) =>
              new DatalogError({
                message: error.message,
                cause: error.cause,
              }),
          ),
        );

        return result as { queryPlan: QueryPlan; metrics?: QueryMetrics };
      }).pipe(Effect.withSpan("datalog.explain"));

    /**
     * Explain a wrapped Datalog query: compile and return the query plan without executing.
     * Note: This does local compilation since WrappedQuery has a different shape than DatalogQuery.
     */
    const explainWrapped = (rawQuery: unknown) =>
      Effect.gen(function* () {
        const parseResult = Schema.decodeUnknownEither(WrappedQuery)(rawQuery);
        if (parseResult._tag === "Left") {
          return yield* Effect.fail(
            new DatalogValidationError({
              message: `Invalid wrapped query: ${parseResult.left.message}`,
              query: rawQuery,
              cause: parseResult.left,
            }),
          );
        }

        let compiled: CompiledWrappedQuery;
        try {
          compiled = compileWrapped(parseResult.right, dialect);
        } catch (error) {
          return yield* Effect.fail(
            new DatalogError({
              message: `Failed to compile wrapped query: ${String(error)}`,
              cause: error,
            }),
          );
        }

        const steps: Array<{ label: string; query: string; params?: unknown[] }> = [
          { label: "main", query: compiled.sql, params: [...compiled.params] },
        ];
        if (compiled.countSql) {
          steps.push({
            label: "count",
            query: compiled.countSql,
            params: compiled.countParams ? [...compiled.countParams] : [],
          });
        }

        return {
          queryPlan: {
            backend: dialect.name,
            steps,
          } as QueryPlan,
        };
      }).pipe(Effect.withSpan("datalog.explainWrapped"));

    return {
      query,
      queryValidated,
      queryWrapped,
      explain,
      explainWrapped,
    } satisfies DatalogService;
  }),
);

/**
 * Combined layer that provides both Datalog and TripleStore
 */
export const DatalogLayer = DatalogLive;
