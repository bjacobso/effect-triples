/**
 * Runtime types for Datalog query execution
 */

import type {
  Variable,
  Constant,
  Term,
  PatternClause,
  PredicateClause,
  NotClause,
  OrClause,
  LinkClause,
  RuleApplication,
  RuleBodyClause,
  Rule,
  Clause,
  AggregateOp,
  AggregateSpec,
  OrderDirection,
  OrderBySpec,
  HavingClause,
  DatalogQuery,
  WrapperFilterOp,
  WrapperFilter,
  WrappedQuery,
} from "./schema.js";

// Re-export schema types for convenience
export type {
  Variable,
  Constant,
  Term,
  PatternClause,
  PredicateClause,
  NotClause,
  OrClause,
  LinkClause,
  RuleApplication,
  RuleBodyClause,
  Rule,
  Clause,
  AggregateOp,
  AggregateSpec,
  OrderDirection,
  OrderBySpec,
  HavingClause,
  DatalogQuery,
  WrapperFilterOp,
  WrapperFilter,
  WrappedQuery,
};

/**
 * Context: a mapping from variable names to their bound values
 *
 * Example:
 * ```typescript
 * { "?person": "p1", "?name": "Alice", "?age": 30 }
 * ```
 */
export interface Context {
  readonly [variable: string]: Constant;
}

/**
 * An empty context with no bindings
 */
export const emptyContext: Context = {};

/**
 * Query result: an array of contexts (variable bindings)
 * Each context represents one result row
 */
export type QueryResult = readonly Context[];

/**
 * A simplified triple representation for pattern matching
 * [entityId, attribute, value, txId?]
 * The 4th element (txId) is optional for backward compatibility
 */
export type SimplifiedTriple =
  | readonly [string, string, Constant, string | null]
  | readonly [string, string, Constant];

/**
 * Binding: the result of actualizing a query (extracting find values)
 * Maps variable names to their resolved values
 */
export type Binding = Context;
