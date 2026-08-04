/**
 * Runtime types for SPARQL query execution
 */

import type {
  Variable,
  Constant,
  Term,
  TriplePattern,
  ComparisonOp,
  LogicalOp,
  BuiltInFunction,
  ComparisonExpr,
  BuiltInCall,
  FilterExpression,
  LogicalExpr,
  ExistsExpr,
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
} from "../Sparql.js";

// Re-export schema types for convenience
export type {
  Variable,
  Constant,
  Term,
  TriplePattern,
  ComparisonOp,
  LogicalOp,
  BuiltInFunction,
  ComparisonExpr,
  BuiltInCall,
  FilterExpression,
  LogicalExpr,
  ExistsExpr,
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
};

/**
 * Context: a mapping from variable names to their bound values
 * Same as Datalog Context for compatibility
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
 * Query result for SELECT queries: an array of contexts (variable bindings)
 * Each context represents one result row
 */
export type SelectResult = readonly Context[];

/**
 * Result triple for CONSTRUCT/DESCRIBE queries
 */
export interface ResultTriple {
  readonly subject: string;
  readonly predicate: string;
  readonly object: Constant;
}

/**
 * Query result for CONSTRUCT queries: an array of triples
 */
export type ConstructResult = readonly ResultTriple[];

/**
 * Query result for DESCRIBE queries: an array of triples
 */
export type DescribeResult = readonly ResultTriple[];

/**
 * Query result for ASK queries: a boolean
 */
export type AskResult = boolean;

/**
 * Union type for all query result types
 */
export type QueryResult =
  | { type: "select"; results: SelectResult }
  | { type: "construct"; results: ConstructResult }
  | { type: "describe"; results: DescribeResult }
  | { type: "ask"; result: AskResult };
