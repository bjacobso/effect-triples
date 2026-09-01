/**
 * SQL Compiler for SPARQL Queries
 *
 * Compiles SPARQL-like queries directly to SQL for efficient execution.
 * Supports SELECT, CONSTRUCT, DESCRIBE, and ASK query documents.
 */

import {
  isVariable,
  isTriplePattern,
  isOptionalPattern,
  isUnionPattern,
  isFilterPattern,
  isBindPattern,
  isValuesPattern,
  isMinusPattern,
  isPropertyPathPattern,
  isSubSelectPattern,
  isComparisonExpr,
  isBuiltInCall,
  isLogicalExpr,
  isExistsExpr,
  isSimplePath,
  isSeqPath,
  isAltPath,
  isInversePath,
  isZeroOrMorePath,
  isOneOrMorePath,
  isZeroOrOnePath,
} from "./schema.js";
import type { SqlDialect } from "../dialects/index.js";
import { SqliteDialect } from "../dialects/index.js";
import { createParamCollector, type ParamCollector } from "../params.js";
import type {
  Constant,
  TriplePattern,
  FilterExpression,
  ComparisonExpr,
  BuiltInCall,
  LogicalExpr,
  ExistsExpr,
  BindExpression,
  OptionalPattern,
  UnionPattern,
  FilterPattern,
  BindPattern,
  ValuesPattern,
  MinusPattern,
  PropertyPathPattern,
  SparqlQuery,
} from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Tracks where a variable is bound in the SQL query
 */
interface VariableBinding {
  /** Table alias (e.g., "t0", "t1") */
  alias: string;
  /** Column position: "entity" | "attribute" | "value" */
  position: "entity" | "attribute" | "value";
  /** Value type if known (for value position) */
  valueType?: "string" | "number" | "boolean" | "datetime" | "ref";
  /** Whether this binding might be NULL (from OPTIONAL) */
  nullable?: boolean;
  /** Whether this binding is from a UNION subquery (use variable name as column) */
  fromUnion?: boolean;
  /** The variable name (needed for UNION bindings) */
  variableName?: string;
}

/**
 * Context for SQL compilation
 */
interface CompilerContext {
  /** Maps variable names to their first binding */
  bindings: Map<string, VariableBinding>;
  /** Counter for table aliases */
  aliasCounter: number;
  /** Generated JOIN clauses */
  joins: string[];
  /** Generated WHERE conditions */
  conditions: string[];
  /** Table alias for each pattern clause */
  patternAliases: Map<number, string>;
  /** BIND computed columns: variable -> SQL expression */
  bindExpressions: Map<string, string>;
  /** Aggregate target variables to their SQL expressions */
  aggregateExpressions: Map<string, string>;
  /** Parameter collector for parameterized queries */
  collector: ParamCollector;
  /** SQL dialect */
  dialect: SqlDialect;
  /** Params for JOIN conditions (need to come before WHERE params) */
  joinParams: unknown[];
  /** Params for WHERE conditions */
  whereParams: unknown[];
  /** Whether currently processing an OPTIONAL pattern */
  inOptional: boolean;
  /** Whether we have any real triple patterns (affects FROM clause for UNION-first queries) */
  hasTriplePatterns: boolean;
  /** UNION subquery to use as FROM when it's the first pattern */
  unionFromClause?: string;
}

/**
 * Query compilation metrics
 */
export interface QueryMetrics {
  // SQL Complexity
  joinCount: number;
  leftJoinCount: number;
  whereConditionCount: number;
  subqueryCount: number;
  cteCount: number;
  sqlLength: number;
  paramCount: number;

  // Pattern Breakdown
  triplePatternCount: number;
  optionalCount: number;
  unionCount: number;
  filterCount: number;
  bindCount: number;

  // Features Used
  hasAggregation: boolean;
  hasPropertyPaths: boolean;

  // Timing
  compilationTimeMs: number;
}

/**
 * Result of compiling a SPARQL query
 */
export interface CompiledQuery {
  sql: string;
  /** Parameters for the parameterized query */
  params: unknown[];
  /** Maps result column names to variable names */
  columnMap: Map<string, string>;
  /** Query form (select, construct, describe, ask) */
  form: "select" | "construct" | "describe" | "ask";
  /** Optional metrics - only included when debug=true */
  metrics?: QueryMetrics;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get the SQL column name for a value based on its type
 */
const getValueColumn = (value: Constant): string => {
  if (typeof value === "string") return "value_string";
  if (typeof value === "number") return "value_number";
  if (typeof value === "boolean") return "value_boolean";
  return "value_string";
};

/**
 * Infer value type from a constant
 */
const inferValueType = (value: Constant): "string" | "number" | "boolean" => {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
};

/**
 * Get the column expression for a term in a given alias
 */
const getColumnForPosition = (
  alias: string,
  position: "entity" | "attribute" | "value",
  valueColumn?: string,
): string => {
  switch (position) {
    case "entity":
      return `${alias}.entity_id`;
    case "attribute":
      return `${alias}.attribute`;
    case "value":
      return valueColumn ? `${alias}.${valueColumn}` : `${alias}.value_string`;
  }
};

/**
 * Create a new compiler context
 */
const createContext = (dialect: SqlDialect): CompilerContext => ({
  bindings: new Map(),
  aliasCounter: 0,
  joins: [],
  conditions: [],
  patternAliases: new Map(),
  bindExpressions: new Map(),
  aggregateExpressions: new Map(),
  collector: createParamCollector(dialect),
  dialect,
  joinParams: [],
  whereParams: [],
  inOptional: false,
  hasTriplePatterns: false,
});

/**
 * Get the next table alias
 */
const nextAlias = (ctx: CompilerContext): string => {
  const alias = `t${ctx.aliasCounter}`;
  ctx.aliasCounter++;
  return alias;
};

/**
 * Format a constant value for SQL using parameterized queries
 */
const formatValue = (value: Constant, ctx: CompilerContext): string => {
  const placeholder = ctx.collector.add(value);
  // Track params in separate lists for correct ordering
  // JOIN params must come before WHERE params in the final SQL
  // Use the same conversion as the collector (booleans to 1/0)
  const converted = typeof value === "boolean" ? (value ? 1 : 0) : value;
  if (ctx.inOptional) {
    ctx.joinParams.push(converted);
  } else {
    ctx.whereParams.push(converted);
  }
  return placeholder;
};

/**
 * Get a SELECT expression for a variable (handles different value types)
 */
const getSelectExpr = (variable: string, ctx: CompilerContext): string => {
  // Check if this is a BIND expression
  if (ctx.bindExpressions.has(variable)) {
    return ctx.bindExpressions.get(variable)!;
  }

  // Check if this is an aggregate expression
  if (ctx.aggregateExpressions.has(variable)) {
    return ctx.aggregateExpressions.get(variable)!;
  }

  const binding = ctx.bindings.get(variable);
  if (!binding) {
    throw new Error(`Unbound variable in SELECT: ${variable}`);
  }

  // For UNION bindings, reference the subquery column directly by variable name
  if (binding.fromUnion) {
    return `${binding.alias}."${variable}"`;
  }

  if (binding.position === "value") {
    // For value position, use COALESCE to handle different types
    return `COALESCE(${binding.alias}.value_string, CAST(${binding.alias}.value_number AS TEXT), CAST(${binding.alias}.value_boolean AS TEXT))`;
  }

  return getColumnForPosition(binding.alias, binding.position);
};

// =============================================================================
// Triple Pattern Compilation
// =============================================================================

/**
 * Compile a single triple pattern to SQL
 * Returns the table alias used for this pattern
 */
const compileTriplePattern = (
  pattern: TriplePattern,
  ctx: CompilerContext,
  isFirstPattern: boolean,
  isOptional: boolean = false,
): string => {
  const [subject, predicate, object] = pattern;
  const alias = nextAlias(ctx);

  // Mark that we have real triple patterns
  ctx.hasTriplePatterns = true;

  // Build JOIN or FROM clause
  if (isFirstPattern && !isOptional && !ctx.unionFromClause) {
    // First pattern goes in FROM (no JOIN needed)
    ctx.conditions.push(`${alias}.retracted_at IS NULL`);
  } else {
    // Subsequent patterns are JOINed
    let joinCondition = `${alias}.retracted_at IS NULL`;

    // Check if subject is a bound variable
    if (isVariable(subject) && ctx.bindings.has(subject)) {
      const binding = ctx.bindings.get(subject)!;
      const boundCol = getColumnForPosition(binding.alias, binding.position);
      joinCondition = `${alias}.entity_id = ${boundCol} AND ${joinCondition}`;
    }

    // Check if object is a bound variable (for ref joins)
    if (isVariable(object) && ctx.bindings.has(object)) {
      const binding = ctx.bindings.get(object)!;
      if (binding.position === "value") {
        const boundCol = getColumnForPosition(binding.alias, binding.position, "value_string");
        joinCondition = `${alias}.entity_id = ${boundCol} AND ${joinCondition}`;
      }
    }

    const joinType = isOptional ? "LEFT JOIN" : "JOIN";
    ctx.joins.push(`${joinType} triples ${alias} ON ${joinCondition}`);
  }

  // Process subject term
  if (isVariable(subject)) {
    if (!ctx.bindings.has(subject)) {
      ctx.bindings.set(subject, { alias, position: "entity", nullable: isOptional });
    }
  } else {
    const condition = `${alias}.entity_id = ${formatValue(subject as Constant, ctx)}`;
    if (isOptional && ctx.joins.length > 0) {
      // For OPTIONAL, conditions go in the ON clause, not WHERE
      const lastJoin = ctx.joins[ctx.joins.length - 1]!;
      ctx.joins[ctx.joins.length - 1] = lastJoin.replace(
        ` AND ${alias}.retracted_at IS NULL`,
        ` AND ${condition} AND ${alias}.retracted_at IS NULL`,
      );
    } else {
      ctx.conditions.push(condition);
    }
  }

  // Process predicate term
  if (isVariable(predicate)) {
    if (!ctx.bindings.has(predicate)) {
      ctx.bindings.set(predicate, { alias, position: "attribute", nullable: isOptional });
    }
  } else {
    const condition = `${alias}.attribute = ${formatValue(predicate as Constant, ctx)}`;
    if (isOptional && ctx.joins.length > 0) {
      const lastJoin = ctx.joins[ctx.joins.length - 1]!;
      ctx.joins[ctx.joins.length - 1] = lastJoin.replace(
        ` AND ${alias}.retracted_at IS NULL`,
        ` AND ${condition} AND ${alias}.retracted_at IS NULL`,
      );
    } else {
      ctx.conditions.push(condition);
    }
  }

  // Process object term
  if (isVariable(object)) {
    if (!ctx.bindings.has(object)) {
      ctx.bindings.set(object, { alias, position: "value", nullable: isOptional });
    }
  } else {
    const valueCol = getValueColumn(object as Constant);
    const valueType = inferValueType(object as Constant);
    const condition1 = `${alias}.${valueCol} = ${formatValue(object as Constant, ctx)}`;
    const condition2 = `${alias}.value_type = ${formatValue(valueType, ctx)}`;
    if (isOptional && ctx.joins.length > 0) {
      const lastJoin = ctx.joins[ctx.joins.length - 1]!;
      ctx.joins[ctx.joins.length - 1] = lastJoin.replace(
        ` AND ${alias}.retracted_at IS NULL`,
        ` AND ${condition1} AND ${condition2} AND ${alias}.retracted_at IS NULL`,
      );
    } else {
      ctx.conditions.push(condition1);
      ctx.conditions.push(condition2);
    }
  }

  return alias;
};

// =============================================================================
// OPTIONAL Pattern Compilation
// =============================================================================

/**
 * Compile an OPTIONAL pattern to SQL LEFT JOIN
 */
const compileOptionalPattern = (
  pattern: OptionalPattern,
  ctx: CompilerContext,
  metrics: QueryMetrics,
): void => {
  const innerPatterns = pattern.optional;

  // Set flag so formatValue tracks params in joinParams list
  ctx.inOptional = true;

  for (let i = 0; i < innerPatterns.length; i++) {
    const element = innerPatterns[i];
    compilePatternElement(element, ctx, false, true, metrics);
  }

  ctx.inOptional = false;

  metrics.optionalCount++;
  metrics.leftJoinCount++;
};

// =============================================================================
// UNION Pattern Compilation
// =============================================================================

/**
 * Compile a single UNION branch to SQL
 * Returns the SQL, params, and variable bindings for this branch
 */
const compileUnionBranch = (
  patterns: unknown[],
  parentDialect: SqlDialect,
  metrics: QueryMetrics,
): {
  sql: string;
  params: unknown[];
  boundVariables: Map<string, { position: "entity" | "attribute" | "value" }>;
} => {
  const branchCtx = createContext(parentDialect);
  const boundVariables = new Map<string, { position: "entity" | "attribute" | "value" }>();

  // Compile all patterns in this branch
  for (let i = 0; i < patterns.length; i++) {
    const element = patterns[i];
    const isFirst = i === 0;
    compilePatternElement(element, branchCtx, isFirst, false, metrics);
  }

  // Collect bound variables with their positions
  for (const [varName, binding] of branchCtx.bindings) {
    boundVariables.set(varName, { position: binding.position });
  }

  // Build SQL for this branch
  // SELECT all bound variables
  const selectCols: string[] = [];
  for (const [varName, binding] of branchCtx.bindings) {
    const col = getColumnForPosition(
      binding.alias,
      binding.position,
      binding.position === "value" ? "value_string" : undefined,
    );
    // For value positions, use COALESCE to handle different types
    if (binding.position === "value") {
      selectCols.push(
        `COALESCE(${binding.alias}.value_string, CAST(${binding.alias}.value_number AS TEXT), CAST(${binding.alias}.value_boolean AS TEXT)) AS "${varName}"`,
      );
    } else {
      selectCols.push(`${col} AS "${varName}"`);
    }
  }

  let sql = `SELECT ${selectCols.join(", ")}\nFROM triples t0`;

  if (branchCtx.joins.length > 0) {
    sql += `\n${branchCtx.joins.join("\n")}`;
  }

  if (branchCtx.conditions.length > 0) {
    sql += `\nWHERE ${branchCtx.conditions.join(" AND ")}`;
  }

  // Combine params in correct order
  const params = [...branchCtx.joinParams, ...branchCtx.whereParams];

  return { sql, params, boundVariables };
};

/**
 * Compile a UNION pattern to SQL UNION ALL subquery
 */
const compileUnionPattern = (
  pattern: UnionPattern,
  ctx: CompilerContext,
  metrics: QueryMetrics,
): void => {
  const branches = pattern.union;

  if (branches.length === 0) {
    throw new Error("UNION pattern requires at least one branch");
  }

  // Compile each branch
  const compiledBranches: {
    sql: string;
    params: unknown[];
    boundVariables: Map<string, { position: "entity" | "attribute" | "value" }>;
  }[] = [];

  for (const branch of branches) {
    const compiled = compileUnionBranch(branch as unknown[], ctx.dialect, metrics);
    compiledBranches.push(compiled);
  }

  // Collect all variables across all branches
  const allVariables = new Map<string, { position: "entity" | "attribute" | "value" }>();
  for (const branch of compiledBranches) {
    for (const [varName, info] of branch.boundVariables) {
      if (!allVariables.has(varName)) {
        allVariables.set(varName, info);
      }
    }
  }

  // Rebuild each branch SQL with aligned columns (include NULL for missing variables)
  const alignedBranchSQLs: string[] = [];
  const orderedVars = Array.from(allVariables.keys());

  for (let branchIdx = 0; branchIdx < compiledBranches.length; branchIdx++) {
    const branchPatterns = branches[branchIdx] as unknown[];

    // Recompile with aligned columns
    const branchCtx = createContext(ctx.dialect);

    // Compile patterns
    for (let i = 0; i < branchPatterns.length; i++) {
      const element = branchPatterns[i];
      const isFirst = i === 0;
      compilePatternElement(element, branchCtx, isFirst, false, metrics);
    }

    // Build SELECT with aligned columns
    const selectCols: string[] = [];
    for (const varName of orderedVars) {
      const binding = branchCtx.bindings.get(varName);
      if (binding) {
        if (binding.position === "value") {
          selectCols.push(
            `COALESCE(${binding.alias}.value_string, CAST(${binding.alias}.value_number AS TEXT), CAST(${binding.alias}.value_boolean AS TEXT)) AS "${varName}"`,
          );
        } else {
          const col = getColumnForPosition(binding.alias, binding.position);
          selectCols.push(`${col} AS "${varName}"`);
        }
      } else {
        // Variable not bound in this branch - use NULL
        selectCols.push(`NULL AS "${varName}"`);
      }
    }

    let sql = `SELECT ${selectCols.join(", ")}\nFROM triples t0`;

    if (branchCtx.joins.length > 0) {
      sql += `\n${branchCtx.joins.join("\n")}`;
    }

    if (branchCtx.conditions.length > 0) {
      sql += `\nWHERE ${branchCtx.conditions.join(" AND ")}`;
    }

    alignedBranchSQLs.push(sql);

    // Add params to the parent context
    const branchParams = [...branchCtx.joinParams, ...branchCtx.whereParams];
    for (const param of branchParams) {
      ctx.whereParams.push(param);
    }
  }

  // Create UNION ALL subquery
  const unionAlias = `union_${ctx.aliasCounter}`;
  ctx.aliasCounter++;

  const unionSQL = `(\n${alignedBranchSQLs.join("\nUNION ALL\n")}\n) AS ${unionAlias}`;

  // Determine join condition - join on any shared variable with the main query
  let joinCondition = "1=1";
  const sharedVars: string[] = [];
  for (const varName of orderedVars) {
    if (ctx.bindings.has(varName)) {
      sharedVars.push(varName);
    }
  }

  if (sharedVars.length > 0) {
    const binding = ctx.bindings.get(sharedVars[0]!)!;
    // Handle UNION bindings from nested UNIONs
    const mainCol = binding.fromUnion
      ? `${binding.alias}."${sharedVars[0]}"`
      : getColumnForPosition(
          binding.alias,
          binding.position,
          binding.position === "value" ? "value_string" : undefined,
        );
    joinCondition = `${unionAlias}."${sharedVars[0]}" = ${mainCol}`;
  }

  // Add as JOIN if there are existing patterns, otherwise it becomes the FROM source
  if (ctx.hasTriplePatterns || ctx.unionFromClause) {
    ctx.joins.push(`JOIN ${unionSQL} ON ${joinCondition}`);
  } else {
    // UNION is the first pattern - use as FROM clause instead of "triples t0"
    ctx.unionFromClause = unionSQL;
  }

  // Register UNION variables as bindings in the parent context
  for (const varName of orderedVars) {
    if (!ctx.bindings.has(varName)) {
      // For UNION results, we store them as "virtual" bindings that reference the union alias
      const info = allVariables.get(varName)!;
      ctx.bindings.set(varName, {
        alias: unionAlias,
        position: info.position,
        // Mark as nullable since UNION branches may have NULLs
        nullable: true,
        // Mark as from UNION so getSelectExpr uses variable name as column
        fromUnion: true,
        variableName: varName,
      });
    }
  }

  metrics.unionCount++;
  metrics.subqueryCount++;
};

// =============================================================================
// FILTER Expression Compilation
// =============================================================================

/**
 * Get column expression for a variable in comparison/filter context
 */
const getComparisonColumn = (variable: string, binding: VariableBinding, op: string): string => {
  // For UNION bindings, use the variable name directly
  if (binding.fromUnion) {
    return `${binding.alias}."${variable}"`;
  }

  // Use appropriate column for comparison
  const col =
    binding.position === "value"
      ? op === "=" || op === "!="
        ? "value_string"
        : "value_number"
      : binding.position === "entity"
        ? "entity_id"
        : "attribute";
  return `${binding.alias}.${col}`;
};

/**
 * Compile a comparison expression to SQL
 */
const compileComparisonExpr = (expr: ComparisonExpr, ctx: CompilerContext): string => {
  const { op, left, right } = expr;

  // Resolve left term
  let leftExpr: string;
  if (isVariable(left)) {
    const binding = ctx.bindings.get(left as string);
    if (!binding) {
      throw new Error(`Unbound variable in FILTER: ${left}`);
    }
    leftExpr = getComparisonColumn(left as string, binding, op);
  } else {
    leftExpr = formatValue(left as Constant, ctx);
  }

  // Resolve right term
  let rightExpr: string;
  if (isVariable(right)) {
    const binding = ctx.bindings.get(right as string);
    if (!binding) {
      throw new Error(`Unbound variable in FILTER: ${right}`);
    }
    rightExpr = getComparisonColumn(right as string, binding, op);
  } else {
    rightExpr = formatValue(right as Constant, ctx);
  }

  // Map operator
  const sqlOp = op === "!=" ? "<>" : op;

  return `${leftExpr} ${sqlOp} ${rightExpr}`;
};

/**
 * Compile a built-in function call to SQL
 */
const compileBuiltInCall = (call: BuiltInCall, ctx: CompilerContext): string => {
  const { fn, args } = call;

  // Resolve arguments
  const sqlArgs = args.map((arg) => {
    if (isVariable(arg)) {
      const binding = ctx.bindings.get(arg as string);
      if (!binding) {
        throw new Error(`Unbound variable in FILTER function: ${arg}`);
      }
      // For UNION bindings, use the variable name directly
      if (binding.fromUnion) {
        return `${binding.alias}."${arg}"`;
      }
      return getColumnForPosition(binding.alias, binding.position, "value_string");
    }
    return formatValue(arg as Constant, ctx);
  });

  switch (fn) {
    case "strlen":
      return `LENGTH(${sqlArgs[0]})`;
    case "substr":
      return `SUBSTR(${sqlArgs.join(", ")})`;
    case "contains":
      return `${sqlArgs[0]} LIKE '%' || ${sqlArgs[1]} || '%'`;
    case "strstarts":
      return `${sqlArgs[0]} LIKE ${sqlArgs[1]} || '%'`;
    case "strends":
      return `${sqlArgs[0]} LIKE '%' || ${sqlArgs[1]}`;
    case "ucase":
      return `UPPER(${sqlArgs[0]})`;
    case "lcase":
      return `LOWER(${sqlArgs[0]})`;
    case "concat":
      return sqlArgs.join(" || ");
    case "regex": {
      // Handle regex with optional flags
      // args[0] = string to match, args[1] = pattern, args[2] = flags (optional)
      const strArg = sqlArgs[0];
      const patternArg = sqlArgs[1];
      const flagsArg = args.length > 2 ? args[2] : undefined;

      // Check for case-insensitive flag
      const caseInsensitive = typeof flagsArg === "string" && flagsArg.toLowerCase().includes("i");

      if (ctx.dialect === SqliteDialect) {
        // SQLite: Use REGEXP, handle case-insensitive with LOWER()
        if (caseInsensitive) {
          return `LOWER(${strArg}) REGEXP LOWER(${patternArg})`;
        }
        return `${strArg} REGEXP ${patternArg}`;
      }

      // PostgreSQL: Use ~ operator with flags
      if (caseInsensitive) {
        return `${strArg} ~* ${patternArg}`; // ~* is case-insensitive
      }
      return `${strArg} ~ ${patternArg}`;
    }
    case "abs":
      return `ABS(${sqlArgs[0]})`;
    case "round":
      return `ROUND(${sqlArgs[0]})`;
    case "ceil":
      return `CEILING(${sqlArgs[0]})`;
    case "floor":
      return `FLOOR(${sqlArgs[0]})`;
    case "bound":
      if (isVariable(args[0])) {
        const binding = ctx.bindings.get(args[0] as string);
        if (binding) {
          // For UNION bindings, check the column itself
          if (binding.fromUnion) {
            return `${binding.alias}."${args[0]}" IS NOT NULL`;
          }
          return `${binding.alias}.entity_id IS NOT NULL`;
        }
      }
      return "1 = 1";
    case "notBound":
      // notBound is the inverse of bound - check if variable IS NULL
      if (isVariable(args[0])) {
        const binding = ctx.bindings.get(args[0] as string);
        if (binding) {
          // For UNION bindings, check the column itself
          if (binding.fromUnion) {
            return `${binding.alias}."${args[0]}" IS NULL`;
          }
          return `${binding.alias}.entity_id IS NULL`;
        }
      }
      return "1 = 0"; // If unbound, always false
    case "in": {
      // IN function: first arg is variable, rest are values to check
      if (args.length < 2) {
        throw new Error("IN function requires at least 2 arguments");
      }
      const varArg = sqlArgs[0];
      const inValues = sqlArgs.slice(1).join(", ");
      return `${varArg} IN (${inValues})`;
    }
    case "notIn": {
      // NOT IN function: first arg is variable, rest are values to check
      if (args.length < 2) {
        throw new Error("NOT IN function requires at least 2 arguments");
      }
      const varArg = sqlArgs[0];
      const notInValues = sqlArgs.slice(1).join(", ");
      return `${varArg} NOT IN (${notInValues})`;
    }
    case "langMatches":
      // Simplified - our store doesn't track language tags
      // Just return true for now (matches any language)
      return "1 = 1";
    case "isIri":
    case "isLiteral":
    case "isNumeric":
    case "isBlank":
      // These type checks are simplified for our triple store
      if (isVariable(args[0])) {
        const binding = ctx.bindings.get(args[0] as string);
        if (binding && binding.position === "value") {
          if (fn === "isNumeric") {
            return `${binding.alias}.value_type = 'number'`;
          }
          return `${binding.alias}.value_type IS NOT NULL`;
        }
      }
      return "1 = 1";
    case "str":
      return sqlArgs[0] ?? "NULL";
    case "lang":
    case "datatype":
      // Simplified - our store doesn't track language tags
      return "''";
    default:
      throw new Error(`Unknown built-in function: ${fn}`);
  }
};

/**
 * Compile a logical expression to SQL
 */
const compileLogicalExpr = (expr: LogicalExpr, ctx: CompilerContext): string => {
  const { op, args } = expr;

  const sqlArgs = args.map((arg) => compileFilterExpression(arg, ctx));

  switch (op) {
    case "and":
      return `(${sqlArgs.join(" AND ")})`;
    case "or":
      return `(${sqlArgs.join(" OR ")})`;
    case "not":
      return `NOT (${sqlArgs[0]})`;
    default:
      throw new Error(`Unknown logical operator: ${op}`);
  }
};

/**
 * Compile an EXISTS expression to SQL
 */
const compileExistsExpr = (expr: ExistsExpr, ctx: CompilerContext): string => {
  const { fn, pattern } = expr;

  // Build a subquery for the pattern
  const subConditions: string[] = ["retracted_at IS NULL"];

  // Simple case: just check if first triple pattern exists
  if (pattern.length > 0 && isTriplePattern(pattern[0])) {
    const [subject, predicate, object] = pattern[0];

    if (isVariable(subject)) {
      const binding = ctx.bindings.get(subject as string);
      if (binding) {
        subConditions.push(`entity_id = ${getColumnForPosition(binding.alias, binding.position)}`);
      }
    } else {
      subConditions.push(`entity_id = ${formatValue(subject as Constant, ctx)}`);
    }

    if (!isVariable(predicate)) {
      subConditions.push(`attribute = ${formatValue(predicate as Constant, ctx)}`);
    }

    if (!isVariable(object)) {
      const valueCol = getValueColumn(object as Constant);
      subConditions.push(`${valueCol} = ${formatValue(object as Constant, ctx)}`);
    }
  }

  const exists = `EXISTS (SELECT 1 FROM triples WHERE ${subConditions.join(" AND ")})`;
  return fn === "notExists" ? `NOT ${exists}` : exists;
};

/**
 * Compile a filter expression to SQL
 */
const compileFilterExpression = (expr: FilterExpression, ctx: CompilerContext): string => {
  if (isComparisonExpr(expr)) {
    return compileComparisonExpr(expr as ComparisonExpr, ctx);
  }
  if (isBuiltInCall(expr)) {
    return compileBuiltInCall(expr as BuiltInCall, ctx);
  }
  if (isLogicalExpr(expr)) {
    return compileLogicalExpr(expr as LogicalExpr, ctx);
  }
  if (isExistsExpr(expr)) {
    return compileExistsExpr(expr as ExistsExpr, ctx);
  }
  throw new Error(`Unknown filter expression type`);
};

/**
 * Compile a FILTER pattern to SQL WHERE condition
 */
const compileFilterPattern = (
  pattern: FilterPattern,
  ctx: CompilerContext,
  metrics: QueryMetrics,
): void => {
  const condition = compileFilterExpression(pattern.filter, ctx);
  ctx.conditions.push(condition);
  metrics.filterCount++;
};

// =============================================================================
// BIND Pattern Compilation
// =============================================================================

/**
 * Compile a BIND expression to SQL
 */
const compileBindExpression = (expr: BindExpression, ctx: CompilerContext): string => {
  if (typeof expr === "string" || typeof expr === "number" || typeof expr === "boolean") {
    if (isVariable(expr)) {
      const binding = ctx.bindings.get(expr as string);
      if (binding) {
        return getSelectExpr(expr as string, ctx);
      }
      throw new Error(`Unbound variable in BIND: ${expr}`);
    }
    return formatValue(expr as Constant, ctx);
  }

  // Handle entity types - must check if object before using "in"
  if (typeof expr === "object" && expr !== null) {
    if ("fn" in expr) {
      return compileBuiltInCall(expr as BuiltInCall, ctx);
    }

    if ("op" in expr) {
      const mathExpr = expr as {
        op: unknown;
        left: BindExpression;
        right: BindExpression;
      };
      if (
        mathExpr.op !== "+" &&
        mathExpr.op !== "-" &&
        mathExpr.op !== "*" &&
        mathExpr.op !== "/"
      ) {
        throw new Error(`Unknown BIND operator: ${String(mathExpr.op)}`);
      }
      const left = compileBindExpression(mathExpr.left, ctx);
      const right = compileBindExpression(mathExpr.right, ctx);
      return `(${left} ${mathExpr.op} ${right})`;
    }
  }

  throw new Error("Unknown BIND expression type");
};

/**
 * Compile a BIND pattern
 */
const compileBindPattern = (
  pattern: BindPattern,
  ctx: CompilerContext,
  metrics: QueryMetrics,
): void => {
  const { expr, as: variable } = pattern.bind;
  const sqlExpr = compileBindExpression(expr, ctx);
  ctx.bindExpressions.set(variable, sqlExpr);
  metrics.bindCount++;
};

// =============================================================================
// VALUES Pattern Compilation
// =============================================================================

/**
 * Compile a VALUES pattern to SQL IN clause
 */
const compileValuesPattern = (
  pattern: ValuesPattern,
  ctx: CompilerContext,
  _metrics: QueryMetrics,
): void => {
  const { variables, bindings } = pattern.values;

  for (const variable of variables) {
    // Get all non-null values for this variable
    const values = bindings
      .map((b) => b[variable.replace("?", "")])
      .filter((v) => v !== null && v !== undefined);

    if (values.length > 0) {
      const binding = ctx.bindings.get(variable);
      if (binding) {
        const col = getColumnForPosition(binding.alias, binding.position, "value_string");
        const placeholders = values.map((v) => formatValue(v as Constant, ctx)).join(", ");
        ctx.conditions.push(`${col} IN (${placeholders})`);
      }
    }
  }
};

// =============================================================================
// MINUS Pattern Compilation
// =============================================================================

/**
 * Compile a MINUS pattern to SQL NOT EXISTS
 */
const compileMinusPattern = (
  pattern: MinusPattern,
  ctx: CompilerContext,
  metrics: QueryMetrics,
): void => {
  // Build NOT EXISTS subquery for the pattern
  const innerPattern = pattern.minus;

  if (innerPattern.length > 0 && isTriplePattern(innerPattern[0])) {
    const [subject, predicate, object] = innerPattern[0] as TriplePattern;
    const subConditions: string[] = ["retracted_at IS NULL"];

    if (isVariable(subject)) {
      const binding = ctx.bindings.get(subject as string);
      if (binding) {
        subConditions.push(`entity_id = ${getColumnForPosition(binding.alias, binding.position)}`);
      }
    } else {
      subConditions.push(`entity_id = ${formatValue(subject as Constant, ctx)}`);
    }

    if (!isVariable(predicate)) {
      subConditions.push(`attribute = ${formatValue(predicate as Constant, ctx)}`);
    }

    if (!isVariable(object)) {
      const valueCol = getValueColumn(object as Constant);
      subConditions.push(`${valueCol} = ${formatValue(object as Constant, ctx)}`);
    }

    ctx.conditions.push(`NOT EXISTS (SELECT 1 FROM triples WHERE ${subConditions.join(" AND ")})`);
    metrics.subqueryCount++;
  }
};

// =============================================================================
// Property Path Compilation
// =============================================================================

/**
 * Compile a property path pattern
 * Note: Full property path support is Phase 4 - this is a basic implementation
 */
const compilePropertyPathPattern = (
  pattern: PropertyPathPattern,
  ctx: CompilerContext,
  metrics: QueryMetrics,
): void => {
  const { subject, path, object } = pattern;

  if (isSimplePath(path)) {
    // Simple path is just a regular triple pattern
    const triplePattern: TriplePattern = [subject, path, object];
    compileTriplePattern(triplePattern, ctx, ctx.joins.length === 0);
    return;
  }

  // Complex paths need recursive CTEs
  if (
    isSeqPath(path) ||
    isAltPath(path) ||
    isInversePath(path) ||
    isZeroOrMorePath(path) ||
    isOneOrMorePath(path) ||
    isZeroOrOnePath(path)
  ) {
    metrics.hasPropertyPaths = true;
    metrics.cteCount++;
    throw new Error("Complex property paths are not yet implemented - coming in Phase 4");
  }
};

// =============================================================================
// Pattern Element Compilation
// =============================================================================

/**
 * Compile a single graph pattern element
 * Note: Uses unknown type to handle Schema.Unknown recursive types - uses runtime type guards
 */
const compilePatternElement = (
  element: unknown,
  ctx: CompilerContext,
  isFirst: boolean,
  isOptional: boolean,
  metrics: QueryMetrics,
): void => {
  if (isTriplePattern(element)) {
    compileTriplePattern(element as TriplePattern, ctx, isFirst, isOptional);
    metrics.triplePatternCount++;
    if (!isOptional) {
      metrics.joinCount++;
    }
  } else if (isOptionalPattern(element)) {
    compileOptionalPattern(element as OptionalPattern, ctx, metrics);
  } else if (isUnionPattern(element)) {
    compileUnionPattern(element as UnionPattern, ctx, metrics);
  } else if (isFilterPattern(element)) {
    compileFilterPattern(element as FilterPattern, ctx, metrics);
  } else if (isBindPattern(element)) {
    compileBindPattern(element as BindPattern, ctx, metrics);
  } else if (isValuesPattern(element)) {
    compileValuesPattern(element as ValuesPattern, ctx, metrics);
  } else if (isMinusPattern(element)) {
    compileMinusPattern(element as MinusPattern, ctx, metrics);
  } else if (isPropertyPathPattern(element)) {
    compilePropertyPathPattern(element as PropertyPathPattern, ctx, metrics);
  } else if (isSubSelectPattern(element)) {
    metrics.subqueryCount++;
    throw new Error("Subqueries are not yet implemented - coming in Phase 6");
  }
};

// =============================================================================
// Main Compilation
// =============================================================================

/**
 * Compile a SELECT query to SQL
 */
const compileSelectQuery = (
  query: SparqlQuery,
  ctx: CompilerContext,
  metrics: QueryMetrics,
): string => {
  const { select, where, aggregate, groupBy, having, orderBy, limit, offset } = query;

  if (!select) {
    throw new Error("SELECT query requires select clause");
  }

  // Compile WHERE patterns
  for (let i = 0; i < where.length; i++) {
    const element = where[i];
    const isFirst = i === 0;
    compilePatternElement(element, ctx, isFirst, false, metrics);
  }

  // Process aggregations FIRST so target variables are registered before building SELECT
  if (aggregate && aggregate.length > 0) {
    metrics.hasAggregation = true;
    for (const [op, sourceVar, targetVar] of aggregate) {
      const sourceBinding = ctx.bindings.get(sourceVar);
      if (!sourceBinding) {
        throw new Error(`Unbound variable in aggregation: ${sourceVar}`);
      }
      const sourceCol = getColumnForPosition(
        sourceBinding.alias,
        sourceBinding.position,
        "value_number",
      );

      let aggExpr: string;
      switch (op) {
        case "count":
          aggExpr = `COUNT(${sourceCol})`;
          break;
        case "sum":
          aggExpr = `SUM(${sourceCol})`;
          break;
        case "avg":
          aggExpr = `AVG(${sourceCol})`;
          break;
        case "min":
          aggExpr = `MIN(${sourceCol})`;
          break;
        case "max":
          aggExpr = `MAX(${sourceCol})`;
          break;
        default:
          throw new Error(`Unknown aggregate operator: ${op}`);
      }

      ctx.aggregateExpressions.set(targetVar, aggExpr);
    }
  }

  // Build SELECT columns (now aggregates are already registered)
  const selectColumns: string[] = [];
  const columnMap = new Map<string, string>();

  for (const variable of select.variables) {
    const colName = `"${variable}"`;
    const expr = getSelectExpr(variable, ctx);
    selectColumns.push(`${expr} AS ${colName}`);
    columnMap.set(colName.replace(/"/g, ""), variable);
  }

  // Build SQL
  const distinct = select.distinct ? "DISTINCT " : "";
  // Use UNION FROM clause if present (when UNION is first pattern)
  const fromClause = ctx.unionFromClause ? `FROM ${ctx.unionFromClause}` : "FROM triples t0";
  let sql = `SELECT ${distinct}${selectColumns.join(", ")}\n${fromClause}`;

  if (ctx.joins.length > 0) {
    sql += `\n${ctx.joins.join("\n")}`;
  }

  if (ctx.conditions.length > 0) {
    sql += `\nWHERE ${ctx.conditions.join(" AND ")}`;
  }

  // GROUP BY
  if (groupBy && groupBy.length > 0) {
    const groupCols = groupBy.map((v) => {
      const binding = ctx.bindings.get(v);
      if (!binding) throw new Error(`Unbound variable in GROUP BY: ${v}`);
      return getColumnForPosition(binding.alias, binding.position);
    });
    sql += `\nGROUP BY ${groupCols.join(", ")}`;
  }

  // HAVING
  if (having && having.length > 0) {
    const havingConds = having.map((h) => {
      const { op, left, right } = h;
      let leftExpr: string;
      if (isVariable(left)) {
        if (ctx.aggregateExpressions.has(left as string)) {
          leftExpr = ctx.aggregateExpressions.get(left as string)!;
        } else {
          const binding = ctx.bindings.get(left as string);
          if (!binding) throw new Error(`Unbound variable in HAVING: ${left}`);
          leftExpr = getColumnForPosition(binding.alias, binding.position);
        }
      } else {
        leftExpr = formatValue(left as Constant, ctx);
      }

      let rightExpr: string;
      if (isVariable(right)) {
        if (ctx.aggregateExpressions.has(right as string)) {
          rightExpr = ctx.aggregateExpressions.get(right as string)!;
        } else {
          const binding = ctx.bindings.get(right as string);
          if (!binding) throw new Error(`Unbound variable in HAVING: ${right}`);
          rightExpr = getColumnForPosition(binding.alias, binding.position);
        }
      } else {
        rightExpr = formatValue(right as Constant, ctx);
      }

      const sqlOp = op === "!=" ? "<>" : op;
      return `${leftExpr} ${sqlOp} ${rightExpr}`;
    });
    sql += `\nHAVING ${havingConds.join(" AND ")}`;
  }

  // ORDER BY
  if (orderBy && orderBy.length > 0) {
    const orderCols = orderBy.map((o) => {
      const { variable, direction } = o;
      let col: string;
      if (ctx.aggregateExpressions.has(variable)) {
        col = ctx.aggregateExpressions.get(variable)!;
      } else if (ctx.bindExpressions.has(variable)) {
        col = ctx.bindExpressions.get(variable)!;
      } else {
        const binding = ctx.bindings.get(variable);
        if (!binding) throw new Error(`Unbound variable in ORDER BY: ${variable}`);
        // For value position, use COALESCE to handle mixed types
        // Numbers sort first (if present), otherwise strings, otherwise booleans
        if (binding.position === "value") {
          const { alias } = binding;
          // Use a CASE expression to sort numerically if value_number is present
          col = `COALESCE(${alias}.value_number, ${alias}.value_string, ${alias}.value_boolean)`;
        } else {
          col = getColumnForPosition(binding.alias, binding.position);
        }
      }
      return direction === "desc" ? `${col} DESC` : `${col} ASC`;
    });
    sql += `\nORDER BY ${orderCols.join(", ")}`;
  }

  // LIMIT
  if (limit !== undefined) {
    sql += `\nLIMIT ${formatValue(limit, ctx)}`;
  }

  // OFFSET
  if (offset !== undefined) {
    sql += `\nOFFSET ${formatValue(offset, ctx)}`;
  }

  return sql;
};

/**
 * Compile an ASK query to SQL
 */
const compileAskQuery = (
  query: SparqlQuery,
  ctx: CompilerContext,
  metrics: QueryMetrics,
): string => {
  const { where } = query;

  // Compile WHERE patterns
  for (let i = 0; i < where.length; i++) {
    const element = where[i];
    const isFirst = i === 0;
    compilePatternElement(element, ctx, isFirst, false, metrics);
  }

  // Build EXISTS query
  let sql = `SELECT EXISTS (\n  SELECT 1\n  FROM triples t0`;

  if (ctx.joins.length > 0) {
    sql += `\n  ${ctx.joins.join("\n  ")}`;
  }

  if (ctx.conditions.length > 0) {
    sql += `\n  WHERE ${ctx.conditions.join(" AND ")}`;
  }

  sql += `\n) AS result`;

  return sql;
};

/**
 * Compile a CONSTRUCT query to SQL
 */
const compileConstructQuery = (
  query: SparqlQuery,
  ctx: CompilerContext,
  metrics: QueryMetrics,
): string => {
  const { construct, where } = query;

  if (!construct || construct.length === 0) {
    throw new Error("CONSTRUCT query requires construct template");
  }

  // Compile WHERE patterns
  for (let i = 0; i < where.length; i++) {
    const element = where[i];
    const isFirst = i === 0;
    compilePatternElement(element, ctx, isFirst, false, metrics);
  }

  // Build SELECT for each template triple
  const selectParts: string[] = [];

  for (const [subject, predicate, object] of construct) {
    let subjectExpr: string;
    if (isVariable(subject)) {
      const binding = ctx.bindings.get(subject as string);
      if (!binding) throw new Error(`Unbound variable in CONSTRUCT: ${subject}`);
      subjectExpr = getColumnForPosition(binding.alias, binding.position);
    } else {
      subjectExpr = formatValue(subject as Constant, ctx);
    }

    let predicateExpr: string;
    if (isVariable(predicate)) {
      const binding = ctx.bindings.get(predicate as string);
      if (!binding) throw new Error(`Unbound variable in CONSTRUCT: ${predicate}`);
      predicateExpr = getColumnForPosition(binding.alias, binding.position);
    } else {
      predicateExpr = formatValue(predicate as Constant, ctx);
    }

    let objectExpr: string;
    if (isVariable(object)) {
      objectExpr = getSelectExpr(object as string, ctx);
    } else {
      objectExpr = formatValue(object as Constant, ctx);
    }

    selectParts.push(
      `${subjectExpr} AS subject, ${predicateExpr} AS predicate, ${objectExpr} AS object`,
    );
  }

  // Build SQL (simplified - one template triple at a time)
  let sql = `SELECT DISTINCT ${selectParts[0]}\nFROM triples t0`;

  if (ctx.joins.length > 0) {
    sql += `\n${ctx.joins.join("\n")}`;
  }

  if (ctx.conditions.length > 0) {
    sql += `\nWHERE ${ctx.conditions.join(" AND ")}`;
  }

  return sql;
};

/**
 * Compile a DESCRIBE query to SQL
 */
const compileDescribeQuery = (
  query: SparqlQuery,
  ctx: CompilerContext,
  metrics: QueryMetrics,
): string => {
  const { describe, where } = query;

  if (!describe || describe.length === 0) {
    throw new Error("DESCRIBE query requires describe terms");
  }

  // If there's a WHERE clause, compile it first to get variable bindings
  if (where.length > 0) {
    for (let i = 0; i < where.length; i++) {
      const element = where[i];
      const isFirst = i === 0;
      compilePatternElement(element, ctx, isFirst, false, metrics);
    }
  }

  // Build subquery to find entity IDs to describe
  const entityConditions: string[] = [];
  for (const term of describe) {
    if (isVariable(term)) {
      const binding = ctx.bindings.get(term as string);
      if (binding) {
        entityConditions.push(getColumnForPosition(binding.alias, binding.position));
      }
    } else {
      entityConditions.push(formatValue(term as Constant, ctx));
    }
  }

  // Build SQL to get all triples about the described entities
  let sql: string;
  if (where.length > 0 && ctx.joins.length > 0) {
    // Use subquery to find entities, then get all their triples
    sql = `SELECT t_main.entity_id AS subject, t_main.attribute AS predicate, `;
    sql += `COALESCE(t_main.value_string, CAST(t_main.value_number AS TEXT), CAST(t_main.value_boolean AS TEXT)) AS object\n`;
    sql += `FROM triples t_main\nWHERE t_main.entity_id IN (\n`;
    sql += `  SELECT ${entityConditions[0]}\n  FROM triples t0`;
    if (ctx.joins.length > 0) {
      sql += `\n  ${ctx.joins.join("\n  ")}`;
    }
    if (ctx.conditions.length > 0) {
      sql += `\n  WHERE ${ctx.conditions.join(" AND ")}`;
    }
    sql += `\n) AND t_main.retracted_at IS NULL`;
  } else {
    // Simple case - just get all triples for the constant entities
    sql = `SELECT entity_id AS subject, attribute AS predicate, `;
    sql += `COALESCE(value_string, CAST(value_number AS TEXT), CAST(value_boolean AS TEXT)) AS object\n`;
    sql += `FROM triples\nWHERE entity_id IN (${entityConditions.join(", ")}) AND retracted_at IS NULL`;
  }

  return sql;
};

/**
 * Main compile function
 */
export const compile = (
  query: SparqlQuery,
  dialect: SqlDialect = SqliteDialect,
  debug: boolean = false,
): CompiledQuery => {
  const startTime = performance.now();
  const ctx = createContext(dialect);

  const metrics: QueryMetrics = {
    joinCount: 0,
    leftJoinCount: 0,
    whereConditionCount: 0,
    subqueryCount: 0,
    cteCount: 0,
    sqlLength: 0,
    paramCount: 0,
    triplePatternCount: 0,
    optionalCount: 0,
    unionCount: 0,
    filterCount: 0,
    bindCount: 0,
    hasAggregation: false,
    hasPropertyPaths: false,
    compilationTimeMs: 0,
  };

  let sql: string;
  const columnMap = new Map<string, string>();

  switch (query.form) {
    case "select":
      sql = compileSelectQuery(query, ctx, metrics);
      // Build column map from select variables
      if (query.select) {
        for (const v of query.select.variables) {
          columnMap.set(v, v);
        }
      }
      break;
    case "ask":
      sql = compileAskQuery(query, ctx, metrics);
      columnMap.set("result", "result");
      break;
    case "construct":
      sql = compileConstructQuery(query, ctx, metrics);
      columnMap.set("subject", "subject");
      columnMap.set("predicate", "predicate");
      columnMap.set("object", "object");
      break;
    case "describe":
      sql = compileDescribeQuery(query, ctx, metrics);
      columnMap.set("subject", "subject");
      columnMap.set("predicate", "predicate");
      columnMap.set("object", "object");
      break;
    default:
      throw new Error(`Unknown query form: ${query.form}`);
  }

  // Finalize metrics
  metrics.joinCount = ctx.joins.filter((j) => !j.startsWith("LEFT")).length;
  metrics.leftJoinCount = ctx.joins.filter((j) => j.startsWith("LEFT")).length;
  metrics.whereConditionCount = ctx.conditions.length;
  metrics.sqlLength = sql.length;
  metrics.compilationTimeMs = performance.now() - startTime;

  // Reorder params: JOIN conditions come before WHERE conditions in SQL
  // so their params must come first
  const orderedParams = [...ctx.joinParams, ...ctx.whereParams];
  metrics.paramCount = orderedParams.length;

  const result: CompiledQuery = {
    sql,
    params: orderedParams,
    columnMap,
    form: query.form,
  };

  if (debug) {
    result.metrics = metrics;
  }

  return result;
};

/**
 * Convenience function to compile and return just the SQL string
 */
export const compileToSql = (query: SparqlQuery, dialect: SqlDialect = SqliteDialect): string => {
  return compile(query, dialect).sql;
};
