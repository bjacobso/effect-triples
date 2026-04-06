/**
 * SPARQL Query Engine
 *
 * A JSON-based SPARQL-like query engine for the Triple Store.
 * Compiles queries directly to SQL for efficient execution.
 *
 * @example
 * ```typescript
 * import { Sparql, SparqlLive } from "./sparql"
 *
 * // SELECT query with OPTIONAL
 * const { results } = yield* Sparql.query({
 *   form: "select",
 *   select: { variables: ["?name", "?email"] },
 *   where: [
 *     ["?person", ":name", "?name"],
 *     { optional: [["?person", ":email", "?email"]] }
 *   ]
 * })
 *
 * // ASK query
 * const exists = yield* Sparql.ask({
 *   form: "ask",
 *   where: [["?person", ":name", "Alice"]]
 * })
 * ```
 *
 * @module
 */

// Schema and validation - Effect Schema objects
export {
  Variable,
  IRI,
  Constant,
  Term,
  TriplePattern,
  ComparisonOp,
  LogicalOp,
  BuiltInFunction,
  ComparisonExpr,
  BuiltInCall,
  FilterExpression,
  MathOp,
  BindExpression,
  PropertyPath,
  OptionalPattern,
  UnionPattern,
  FilterPattern,
  BindPattern,
  ValuesPattern,
  MinusPattern,
  PropertyPathPattern,
  SubSelectPattern,
  GraphPatternElement,
  GraphPattern,
  AggregateOp,
  AggregateSpec,
  OrderDirection,
  OrderBySpec,
  HavingClause,
  QueryForm,
  SelectClause,
  SparqlQuery,
  // Helper functions
  isVariable,
  isIRI,
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

// Re-export types explicitly for isolatedModules
export type { LogicalExpr, ExistsExpr } from "./schema.js";

// Types
export type {
  Context,
  SelectResult,
  ResultTriple,
  ConstructResult,
  DescribeResult,
  AskResult,
  QueryResult,
} from "./types.js";
export { emptyContext } from "./types.js";

// SQL Compiler
export { compile, compileToSql, type CompiledQuery, type QueryMetrics } from "./compiler.js";

// Service and Layer
export { Sparql, type SparqlService, type QueryDebugInfo } from "./service.js";
export { SparqlLive, SparqlLayer } from "./layer.js";
