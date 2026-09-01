/**
 * SqlQueryExecutor - SQL-based implementation of QueryExecutor
 *
 * Compiles Datalog queries to SQL and executes them via SqlClient.
 * This is the default executor for SQL backends (SQLite, PostgreSQL).
 *
 * Non-SQL backends (e.g., FoundationDB via kv-store) implement
 * QueryExecutor directly using index scans.
 */

import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  QueryExecutor,
  type QueryExecutorService,
  type QueryContext,
  type QueryExecutorMetrics,
  CurrentDialect,
  ReadError,
  compile,
  compileWithRules,
  compileWrapped,
  type CompiledQuery,
  type CompiledWrappedQuery,
  SqliteDialect,
  createPaginationCursor,
} from "effect-triples";

// =============================================================================
// Result Row Type
// =============================================================================

type ResultRow = Record<string, unknown>;

// =============================================================================
// Result Conversion
// =============================================================================

const rowToContext = (row: ResultRow, columnMap: Map<string, string>): QueryContext => {
  const context: Record<string, string | number | boolean | null> = {};

  for (const [colName, varName] of columnMap) {
    const value = row[colName];

    if (value === null || value === undefined) {
      context[varName] = null;
      continue;
    }

    if (typeof value === "string") {
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
      context[varName] = String(value);
    }
  }

  return context;
};

// =============================================================================
// Query Plan Builder
// =============================================================================

interface QueryPlan {
  readonly backend: string;
  readonly steps: ReadonlyArray<{
    readonly label: string;
    readonly query: string;
    readonly params?: readonly unknown[];
  }>;
}

interface QueryDebugInfo {
  readonly metrics: QueryExecutorMetrics;
  readonly executionTimeMs: number;
  readonly resultCount: number;
  readonly queryPlan?: QueryPlan;
  readonly generatedSql?: string;
  readonly params?: readonly unknown[];
}

type QueryResult = readonly QueryContext[];

const buildQueryPlan = (
  dialectName: string,
  mainSql: string,
  mainParams: readonly unknown[],
  countSql?: string | null,
  countParams?: readonly unknown[],
): QueryPlan => {
  const steps: Array<{ label: string; query: string; params?: readonly unknown[] }> = [
    { label: "main", query: mainSql, params: [...mainParams] },
  ];
  if (countSql) {
    steps.push({ label: "count", query: countSql, params: countParams ? [...countParams] : [] });
  }
  return { backend: dialectName, steps };
};

// =============================================================================
// Layer Implementation
// =============================================================================

/**
 * SQL-based QueryExecutor implementation.
 * Compiles Datalog -> SQL and executes via SqlClient.
 */
export const SqlQueryExecutorLive = Layer.effect(
  QueryExecutor,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Resolve dialect from context (optional -- defaults to SQLite)
    const dialectOpt = yield* Effect.serviceOption(CurrentDialect);
    const dialect = dialectOpt._tag === "Some" ? dialectOpt.value : SqliteDialect;

    const execute: QueryExecutorService["execute"] = (q, debug = false) =>
      Effect.gen(function* () {
        // 1. Compile to SQL. Recursive rules go through the CTE compiler.
        let compiled: CompiledQuery;
        try {
          compiled = q.rules?.length
            ? compileWithRules(q, dialect, debug)
            : compile(q, dialect, debug);
        } catch (error) {
          return yield* Effect.fail(
            new ReadError({
              message: `Failed to compile Datalog query: ${String(error)}`,
              cause: error,
            }),
          );
        }

        // 2. Execute SQL
        const execStart = performance.now();
        const rows = yield* sql.unsafe<ResultRow>(compiled.sql, compiled.params).pipe(
          Effect.mapError(
            (error) =>
              new ReadError({
                message: `Failed to execute Datalog query SQL: ${String(error)}`,
                cause: error,
              }),
          ),
        );
        const execTime = performance.now() - execStart;

        // 3. Convert rows to QueryContext objects
        const results: QueryContext[] = rows.map((row) => rowToContext(row, compiled.columnMap));

        // 4. Return with optional debug info
        if (debug && compiled.metrics) {
          const debugInfo: QueryDebugInfo = {
            metrics: compiled.metrics as QueryExecutorMetrics,
            executionTimeMs: execTime,
            resultCount: results.length,
            generatedSql: compiled.sql,
            params: compiled.params,
            queryPlan: buildQueryPlan(dialect.name, compiled.sql, compiled.params),
          };
          return { results: results as QueryResult, debug: debugInfo };
        }

        return { results: results as QueryResult };
      });

    const executePage: QueryExecutorService["executePage"] = (q, debug = false) =>
      Effect.gen(function* () {
        // 1. Compile to SQL with CTE wrapper
        let compiled: CompiledWrappedQuery;
        try {
          compiled = compileWrapped(q, dialect);
        } catch (error) {
          return yield* Effect.fail(
            new ReadError({
              message: `Failed to compile wrapped query: ${String(error)}`,
              cause: error,
            }),
          );
        }

        // 2. Execute main query
        const execStart = performance.now();
        const rows = yield* sql.unsafe<ResultRow>(compiled.sql, [...compiled.params]).pipe(
          Effect.mapError(
            (error) =>
              new ReadError({
                message: `Failed to execute wrapped query SQL: ${String(error)}`,
                cause: error,
              }),
          ),
        );
        const execTime = performance.now() - execStart;

        // 3. Execute count query if requested
        let totalCount: number | undefined;
        if (compiled.countSql) {
          const countRows = yield* sql
            .unsafe<{ total: number }>(compiled.countSql, [...compiled.countParams])
            .pipe(
              Effect.mapError(
                (error) =>
                  new ReadError({
                    message: `Failed to execute count query SQL: ${String(error)}`,
                    cause: error,
                  }),
              ),
            );
          totalCount = countRows[0]?.total ?? 0;
        }

        // 4. Convert rows to QueryContext objects
        const results: QueryContext[] = rows.map((row) => rowToContext(row, compiled.columnMap));

        // 5. Compute nextCursor
        let nextCursor: string | undefined;
        if (q.orderBy && q.orderBy.length > 0 && q.limit && results.length === q.limit) {
          const lastRow = results[results.length - 1]!;
          nextCursor = createPaginationCursor(
            lastRow as Record<string, string | number | boolean>,
            q.orderBy,
          );
        }

        // 6. Build result
        const debugInfo: QueryDebugInfo | undefined = debug
          ? {
              metrics: {
                joinCount: 0,
                whereConditionCount: 0,
                subqueryCount: 1,
                cteCount: 1,
                sqlLength: compiled.sql.length,
                paramCount: compiled.params.length,
                patternCount: 0,
                predicateCount: 0,
                notClauseCount: 0,
                orClauseCount: 0,
                linkClauseCount: 0,
                hasAggregation: false,
                isRecursive: false,
                aggregateOps: [],
                compilationTimeMs: 0,
              },
              executionTimeMs: execTime,
              resultCount: results.length,
              generatedSql: compiled.sql,
              params: [...compiled.params],
              queryPlan: buildQueryPlan(
                dialect.name,
                compiled.sql,
                compiled.params,
                compiled.countSql,
                compiled.countParams,
              ),
            }
          : undefined;

        return {
          results: results as QueryResult,
          ...(totalCount !== undefined && { totalCount }),
          ...(nextCursor !== undefined && { nextCursor }),
          ...(debugInfo !== undefined && { debug: debugInfo }),
        };
      });

    const explain: QueryExecutorService["explain"] = (q) =>
      Effect.gen(function* () {
        let compiled: CompiledQuery;
        try {
          compiled = q.rules?.length
            ? compileWithRules(q, dialect, true)
            : compile(q, dialect, true);
        } catch (error) {
          return yield* Effect.fail(
            new ReadError({
              message: `Failed to compile Datalog query: ${String(error)}`,
              cause: error,
            }),
          );
        }

        return {
          queryPlan: buildQueryPlan(dialect.name, compiled.sql, compiled.params),
          ...(compiled.metrics && { metrics: compiled.metrics as QueryExecutorMetrics }),
        };
      });

    const explainPage: QueryExecutorService["explainPage"] = (q) =>
      Effect.gen(function* () {
        let compiled: CompiledWrappedQuery;
        try {
          compiled = compileWrapped(q, dialect);
        } catch (error) {
          return yield* Effect.fail(
            new ReadError({
              message: `Failed to compile wrapped query: ${String(error)}`,
              cause: error,
            }),
          );
        }

        return {
          queryPlan: buildQueryPlan(
            dialect.name,
            compiled.sql,
            compiled.params,
            compiled.countSql,
            compiled.countParams,
          ),
        };
      });

    return {
      execute,
      executePage,
      explain,
      explainPage,
    } satisfies QueryExecutorService;
  }),
);
