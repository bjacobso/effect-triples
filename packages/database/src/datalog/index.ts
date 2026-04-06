/**
 * Datalog Query Engine
 *
 * A JSON-based Datalog query engine for the Triple Store.
 * Compiles queries directly to SQL for efficient execution.
 *
 * @example
 * ```typescript
 * import { Datalog, DatalogLive } from "./datalog"
 *
 * const result = yield* Datalog.query({
 *   find: ["?name", "?age"],
 *   where: [
 *     ["?person", ":name", "?name"],
 *     ["?person", ":age", "?age"],
 *     [">=", "?age", 18]
 *   ]
 * })
 * ```
 *
 * @module
 */

// Schema and validation
export {
  Variable,
  DatalogAttribute,
  Constant,
  Term,
  PredicateOp,
  PatternClause,
  PredicateClause,
  NotClause,
  OrClause,
  LinkClause,
  Clause,
  AggregateOp,
  AggregateSpec,
  DatalogQuery,
  WrapperFilterOp,
  WrapperFilter,
  WrappedQuery,
  isVariable,
  isAttribute,
  isPredicateClause,
  isPatternClause,
  isNotClause,
  isOrClause,
  isLinkClause,
} from "./schema.js";

// Types
export type { Context, QueryResult, SimplifiedTriple, Binding } from "./types.js";
export { emptyContext } from "./types.js";

// SQL Compiler
export { compile, compileToSql, type CompiledQuery } from "./compiler.js";

// Wrapper Compiler (CTE-based subquery pagination)
export { compileWrapped, type CompiledWrappedQuery } from "./wrapper.js";

// Legacy: Engine functions (kept for testing, may be deprecated)
export { matchPattern, querySingle, queryWhere, actualize, query, querySync } from "./engine.js";

// Legacy: Predicate evaluation (kept for testing)
export {
  resolveTerm,
  resolveTermSync,
  evaluatePredicate,
  evaluatePredicateSync,
} from "./predicates.js";

// Service (Layer implementations live in @open-ontology/database-sql)
export {
  Datalog,
  type DatalogService,
  type QueryPlan,
  type WrappedQueryResult,
} from "./service.js";

// NOTE: DatalogLive and SqlQueryExecutorLive have moved to @open-ontology/database-sql.
// NOTE: QueryAST translation (toDatalogQuery) and type checker (typeCheckDatalogQuery)
// live in the compiler layer — they depend on compiler/lisp infrastructure.
