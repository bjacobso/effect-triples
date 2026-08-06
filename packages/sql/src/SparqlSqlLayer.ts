/**
 * SPARQL SQL layer implementation
 *
 * Connects the SPARQL query engine to the Triples service.
 * Uses SQL compilation for efficient query execution.
 */

import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "@effect/sql";
import {
  Triples,
  Sparql,
  type SparqlService,
  type SparqlQueryDebugInfo as QueryDebugInfo,
  SparqlQuery,
  compileSparql,
  type SparqlCompiledQuery as CompiledQuery,
  SparqlValidationError,
  SparqlError,
  ReadError,
} from "effect-triples";
import type {
  SparqlContext as Context,
  SparqlQueryResult as QueryResult,
  SelectResult,
} from "effect-triples";

// =============================================================================
// Result Row Type
// =============================================================================

/**
 * Generic row type for SQL results
 * Column names are the variable names (e.g., "?name", "?age")
 */
type ResultRow = Record<string, unknown>;

// =============================================================================
// Result Conversion
// =============================================================================

/**
 * Convert a SQL result row to a Context
 * Handles type conversion for different value types
 */
const rowToContext = (row: ResultRow, columnMap: Map<string, string>): Context => {
  const context: Record<string, string | number | boolean> = {};

  for (const [colName, varName] of columnMap) {
    const value = row[colName];

    if (value === null || value === undefined) {
      continue;
    }

    // Handle type conversion
    if (typeof value === "string") {
      // Try to parse as number if it looks like one
      const num = Number(value);
      if (!isNaN(num) && value.trim() !== "") {
        context[varName] = num;
      } else {
        context[varName] = value;
      }
    } else if (typeof value === "number") {
      context[varName] = value;
    } else if (typeof value === "boolean") {
      context[varName] = value;
    } else if (typeof value === "bigint") {
      context[varName] = Number(value);
    } else {
      // Fallback to string conversion
      context[varName] = String(value);
    }
  }

  return context;
};

// =============================================================================
// Layer Implementation
// =============================================================================

/**
 * SparqlLive layer
 *
 * Provides the SPARQL service using SQL compilation for query execution.
 * Requires both Triples and SqlClient services.
 */
export const SparqlLive = Layer.effect(
  Sparql,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Require Triples so SPARQL and writes share the same database context.
    yield* Triples;

    /**
     * Execute a SPARQL query with validation
     */
    const query = (rawQuery: unknown, debug = false) =>
      Effect.gen(function* () {
        // 1. Validate query with Effect Schema
        const parseResult = Schema.decodeUnknownEither(SparqlQuery)(rawQuery);

        if (parseResult._tag === "Left") {
          return yield* Effect.fail(
            new SparqlValidationError({
              message: `Invalid SPARQL query: ${parseResult.left.message}`,
              query: rawQuery,
              cause: parseResult.left,
            }),
          );
        }

        const q = parseResult.right;

        // 2. Compile to SQL (with metrics if debug=true)
        let compiled: CompiledQuery;
        try {
          compiled = compileSparql(q, undefined, debug);
        } catch (error) {
          return yield* Effect.fail(
            new SparqlError({
              message: `Failed to compile SPARQL query: ${String(error)}`,
              cause: error,
            }),
          );
        }

        // 3. Execute SQL with parameters
        const execStart = performance.now();
        const rows = yield* sql.unsafe<ResultRow>(compiled.sql, compiled.params).pipe(
          Effect.mapError(
            (error) =>
              new ReadError({
                message: `Failed to execute SPARQL query SQL: ${String(error)}`,
                cause: error,
              }),
          ),
        );
        const execTime = performance.now() - execStart;

        // 4. Convert rows to appropriate result type
        let results: QueryResult;
        switch (compiled.form) {
          case "select": {
            const contexts: Context[] = rows.map((row) => rowToContext(row, compiled.columnMap));
            results = { type: "select", results: contexts as SelectResult };
            break;
          }
          case "ask": {
            const result = rows.length > 0 && (rows[0] as { result: unknown }).result;
            results = { type: "ask", result: Boolean(result) };
            break;
          }
          case "construct":
          case "describe": {
            const triples = rows.map((row) => ({
              subject: String(row["subject"]),
              predicate: String(row["predicate"]),
              object: row["object"] as string | number | boolean,
            }));
            results = { type: compiled.form, results: triples };
            break;
          }
        }

        // 5. Return results with optional debug info
        if (debug && compiled.metrics) {
          const debugInfo: QueryDebugInfo = {
            metrics: compiled.metrics,
            executionTimeMs: execTime,
            resultCount: rows.length,
            generatedSql: compiled.sql,
            params: compiled.params,
          };
          return { results, debug: debugInfo };
        }

        return { results };
      });

    /**
     * Execute a pre-validated SPARQL query (skip validation)
     */
    const queryValidated = (q: typeof SparqlQuery.Type, debug = false) =>
      Effect.gen(function* () {
        // 1. Compile to SQL (with metrics if debug=true)
        let compiled: CompiledQuery;
        try {
          compiled = compileSparql(q, undefined, debug);
        } catch (error) {
          return yield* Effect.fail(
            new SparqlError({
              message: `Failed to compile SPARQL query: ${String(error)}`,
              cause: error,
            }),
          );
        }

        // 2. Execute SQL with parameters
        const execStart = performance.now();
        const rows = yield* sql.unsafe<ResultRow>(compiled.sql, compiled.params).pipe(
          Effect.mapError(
            (error) =>
              new ReadError({
                message: `Failed to execute SPARQL query SQL: ${String(error)}`,
                cause: error,
              }),
          ),
        );
        const execTime = performance.now() - execStart;

        // 3. Convert rows to appropriate result type
        let results: QueryResult;
        switch (compiled.form) {
          case "select": {
            const contexts: Context[] = rows.map((row) => rowToContext(row, compiled.columnMap));
            results = { type: "select", results: contexts as SelectResult };
            break;
          }
          case "ask": {
            const result = rows.length > 0 && (rows[0] as { result: unknown }).result;
            results = { type: "ask", result: Boolean(result) };
            break;
          }
          case "construct":
          case "describe": {
            const triples = rows.map((row) => ({
              subject: String(row["subject"]),
              predicate: String(row["predicate"]),
              object: row["object"] as string | number | boolean,
            }));
            results = { type: compiled.form, results: triples };
            break;
          }
        }

        // 4. Return results with optional debug info
        if (debug && compiled.metrics) {
          const debugInfo: QueryDebugInfo = {
            metrics: compiled.metrics,
            executionTimeMs: execTime,
            resultCount: rows.length,
            generatedSql: compiled.sql,
            params: compiled.params,
          };
          return { results, debug: debugInfo };
        }

        return { results };
      });

    /**
     * Execute a SELECT query and return just the bindings
     */
    const select = (rawQuery: unknown) =>
      Effect.gen(function* () {
        const { results } = yield* query(rawQuery);
        if (results.type !== "select") {
          return yield* Effect.fail(
            new SparqlError({
              message: `Expected SELECT query, got ${results.type}`,
            }),
          );
        }
        return results.results;
      });

    /**
     * Execute an ASK query and return the boolean result
     */
    const ask = (rawQuery: unknown) =>
      Effect.gen(function* () {
        const { results } = yield* query(rawQuery);
        if (results.type !== "ask") {
          return yield* Effect.fail(
            new SparqlError({
              message: `Expected ASK query, got ${results.type}`,
            }),
          );
        }
        return results.result;
      });

    return {
      query,
      queryValidated,
      select,
      ask,
    } satisfies SparqlService;
  }),
);

/**
 * Combined layer that provides SPARQL with all its dependencies
 */
export const SparqlLayer = SparqlLive;
