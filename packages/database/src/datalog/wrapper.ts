/**
 * Query Wrapper Compiler
 *
 * Wraps a Datalog query in a CTE to enable:
 * - Additional filtering on result columns
 * - Separate pagination from inner query
 * - Total count retrieval for pagination UI
 */

import { compile, type CompiledQuery } from "./compiler.js";
import { isVariable } from "./schema.js";
import type { SqlDialect } from "../dialects/index.js";
import { SqliteDialect } from "../dialects/sqlite.js";
import { createParamCollector, type ParamCollector } from "../params.js";
import type { WrappedQuery, WrapperFilter, WrapperFilterOp, OrderBySpec } from "./types.js";
import type { PaginationCursorData } from "../Branded.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Result of compiling a wrapped query
 */
export interface CompiledWrappedQuery {
  /** SQL for fetching paginated results */
  sql: string;
  /** SQL for fetching total count (only if includeCount=true) */
  countSql: string | null;
  /** Parameters for the main query */
  params: readonly unknown[];
  /** Parameters for the count query */
  countParams: readonly unknown[];
  /** Column map from inner query */
  columnMap: Map<string, string>;
}

// =============================================================================
// Filter Compilation
// =============================================================================

/**
 * Compile a wrapper filter operator to SQL
 */
const compileFilterOp = (
  colName: string,
  op: WrapperFilterOp,
  value: unknown,
  collector: ParamCollector,
  dialect: SqlDialect,
): string => {
  switch (op) {
    case "=":
      return `${colName} = ${collector.add(value)}`;
    case "!=":
      return `${colName} <> ${collector.add(value)}`;
    case ">":
      return `${colName} > ${collector.add(value)}`;
    case ">=":
      return `${colName} >= ${collector.add(value)}`;
    case "<":
      return `${colName} < ${collector.add(value)}`;
    case "<=":
      return `${colName} <= ${collector.add(value)}`;
    case "like":
      return `${colName} LIKE ${collector.add(value)}`;
    case "not-like":
      return `${colName} NOT LIKE ${collector.add(value)}`;
    case "ilike":
      // SQLite: use LIKE with COLLATE NOCASE
      // PostgreSQL: use native ILIKE
      if (dialect.name === "postgresql") {
        return `${colName} ILIKE ${collector.add(value)}`;
      }
      return `${colName} LIKE ${collector.add(value)} COLLATE NOCASE`;
    case "not-ilike":
      if (dialect.name === "postgresql") {
        return `${colName} NOT ILIKE ${collector.add(value)}`;
      }
      return `${colName} NOT LIKE ${collector.add(value)} COLLATE NOCASE`;
    case "is-null":
      return `${colName} IS NULL`;
    case "is-not-null":
      return `${colName} IS NOT NULL`;
    default: {
      const _exhaustive: never = op;
      throw new Error(`Unknown filter operator: ${_exhaustive}`);
    }
  }
};

/**
 * Compile a wrapper filter to SQL condition
 */
const compileFilter = (
  filter: WrapperFilter,
  collector: ParamCollector,
  dialect: SqlDialect,
): string => {
  const colName = `"${filter.column}"`;
  return compileFilterOp(colName, filter.op, filter.value, collector, dialect);
};

/**
 * Compile wrapper filters to WHERE clause
 */
const compileFilters = (
  filters: readonly WrapperFilter[] | undefined,
  collector: ParamCollector,
  dialect: SqlDialect,
): string => {
  if (!filters || filters.length === 0) {
    return "";
  }
  const conditions = filters.map((f) => compileFilter(f, collector, dialect));
  return `WHERE ${conditions.join(" AND ")}`;
};

// =============================================================================
// Order By Compilation
// =============================================================================

/**
 * Compile wrapper order by to SQL clause
 */
const compileOrderBy = (orderBy: readonly OrderBySpec[] | undefined): string => {
  if (!orderBy || orderBy.length === 0) {
    return "";
  }
  const parts = orderBy.map(
    ({ variable, direction = "asc" }) => `"${variable}" ${direction.toUpperCase()}`,
  );
  return `ORDER BY ${parts.join(", ")}`;
};

// =============================================================================
// Cursor/Keyset Pagination
// =============================================================================

/**
 * Decode a base64-encoded cursor string to PaginationCursorData
 */
const decodeCursor = (cursor: string): PaginationCursorData => {
  return JSON.parse(atob(cursor)) as PaginationCursorData;
};

/**
 * Generate keyset WHERE clause for cursor pagination
 *
 * For single column orderBy (simple case):
 *   WHERE "?name" > ?
 *
 * For multi-column orderBy with mixed directions:
 *   orderBy: [{?dept, asc}, {?age, desc}]  cursor: {?dept: "Eng", ?age: 30}
 *   WHERE (
 *     "?dept" > ?                              -- dept after cursor
 *     OR ("?dept" = ? AND "?age" < ?)          -- same dept, younger (desc)
 *   )
 *
 * This generates a compound OR condition that correctly handles
 * multi-column sort orders with mixed directions.
 */
const compileKeysetClause = (
  orderBy: readonly OrderBySpec[],
  cursor: PaginationCursorData,
  collector: ParamCollector,
): string => {
  if (orderBy.length === 0) return "";

  // Single column case: simple comparison
  if (orderBy.length === 1) {
    const first = orderBy[0]!;
    const { variable, direction = "asc" } = first;
    const op = direction === "asc" ? ">" : "<";
    return `"${variable}" ${op} ${collector.add(cursor[variable])}`;
  }

  // Multi-column: compound OR conditions
  // For [{a, asc}, {b, desc}]: (a > ?) OR (a = ? AND b < ?)
  const conditions: string[] = [];
  for (let i = 0; i < orderBy.length; i++) {
    const parts: string[] = [];
    // Equality for all previous columns
    for (let j = 0; j < i; j++) {
      const prev = orderBy[j]!;
      parts.push(`"${prev.variable}" = ${collector.add(cursor[prev.variable])}`);
    }
    // Comparison for current column
    const current = orderBy[i]!;
    const { variable, direction = "asc" } = current;
    const op = direction === "asc" ? ">" : "<";
    parts.push(`"${variable}" ${op} ${collector.add(cursor[variable])}`);
    conditions.push(`(${parts.join(" AND ")})`);
  }
  return `(${conditions.join(" OR ")})`;
};

// =============================================================================
// Main Compilation
// =============================================================================

/**
 * Compile a wrapped query to SQL
 *
 * Strategy:
 * 1. Compile inner query to SQL using existing compiler
 * 2. Wrap in CTE: WITH inner_results AS (inner_sql)
 * 3. Generate outer SELECT with filters and pagination
 * 4. Generate count query if requested
 */
export const compileWrapped = (
  query: WrappedQuery,
  dialect: SqlDialect = SqliteDialect,
): CompiledWrappedQuery => {
  const { inner, filters, orderBy, limit, cursor, includeCount } = query;

  // 1. Compile inner query (without wrapper's orderBy/limit/cursor)
  const innerCompiled: CompiledQuery = compile(inner, dialect);

  // 2. Build CTE
  const cteName = "inner_results";
  const cte = `WITH ${cteName} AS (\n${innerCompiled.sql}\n)`;

  // 3. Build SELECT columns from inner query's find clause
  const selectColumns = inner.find
    .filter((term): term is string => typeof term === "string" && isVariable(term))
    .map((v) => `"${v}"`)
    .join(", ");

  // 4. Build wrapper WHERE clause from filters + cursor (main query)
  const mainCollector = createParamCollector(dialect);

  // First, add all inner query params to maintain parameter order
  for (const p of innerCompiled.params) {
    mainCollector.add(p);
  }

  // Collect WHERE conditions: filters + cursor keyset clause
  const whereConditions: string[] = [];

  // Add filter conditions
  if (filters && filters.length > 0) {
    const filterConditions = filters.map((f) => compileFilter(f, mainCollector, dialect));
    whereConditions.push(...filterConditions);
  }

  // Add cursor keyset condition (requires orderBy to be specified)
  if (cursor && orderBy && orderBy.length > 0) {
    const cursorData = decodeCursor(cursor);
    const keysetCondition = compileKeysetClause(orderBy, cursorData, mainCollector);
    if (keysetCondition) {
      whereConditions.push(keysetCondition);
    }
  }

  // Build WHERE clause
  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  // 5. Build wrapper ORDER BY
  const orderByClause = compileOrderBy(orderBy);

  // 6. Build wrapper LIMIT (no offset - cursor pagination uses keyset)
  const limitClause = limit ? dialect.limitOffset(limit, undefined) : "";

  // 7. Assemble main query
  const sqlParts = [
    cte,
    `SELECT ${selectColumns || "*"}`,
    `FROM ${cteName}`,
    whereClause,
    orderByClause,
    limitClause,
  ];
  const sql = sqlParts.filter(Boolean).join("\n");

  // 8. Build count query if requested
  // Note: Count query does NOT include cursor keyset clause - it counts total filtered results
  let countSql: string | null = null;
  let countParams: readonly unknown[] = [];

  if (includeCount) {
    const countCollector = createParamCollector(dialect);

    // Add inner query params
    for (const p of innerCompiled.params) {
      countCollector.add(p);
    }

    // Only apply filters to count, not cursor (we want total count of all matching rows)
    const countWhereClause = compileFilters(filters, countCollector, dialect);

    const countSqlParts = [cte, `SELECT COUNT(*) AS total`, `FROM ${cteName}`, countWhereClause];
    countSql = countSqlParts.filter(Boolean).join("\n");
    countParams = countCollector.params;
  }

  return {
    sql,
    countSql,
    params: mainCollector.params,
    countParams,
    columnMap: innerCompiled.columnMap,
  };
};
