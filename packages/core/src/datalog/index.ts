/**
 * Datalog Query Engine
 *
 * A JSON-based Datalog query engine for the Triple Store.
 * Compiles queries directly to SQL for efficient execution.
 *
 * @example
 * ```typescript
 * import { Triples } from "effect-triples"
 *
 * const result = yield* Triples.query({
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
  OrAlternative,
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
  normalizeOrAlternatives,
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

// NOTE: QueryPlan translation (toDatalogQuery) and type checker (typeCheckDatalogQuery)
// live in the compiler layer — they depend on compiler/lisp infrastructure.
