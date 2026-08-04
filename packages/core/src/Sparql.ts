/**
 * SPARQL Module
 *
 * SPARQL-like query language with JSON DSL for graph pattern matching.
 * Supports OPTIONAL, UNION, FILTER, BIND, VALUES, and property paths.
 *
 * Note: Due to TypeScript circular inference limitations, some complex recursive
 * types use Schema.Unknown and are validated at runtime by the compiler.
 */

import { Schema } from "effect";

// =============================================================================
// Primitive Terms
// =============================================================================

/**
 * Variable: a string starting with "?" followed by an identifier
 * Examples: "?person", "?age", "?movieTitle"
 */
export const Variable = Schema.String.pipe(
  Schema.pattern(/^\?[a-zA-Z_][a-zA-Z0-9_]*$/),
  Schema.annotations({
    identifier: "Variable",
    description: "A SPARQL variable starting with ? (e.g., ?person, ?age)",
  }),
);

/**
 * IRI/Attribute: a string starting with ":" followed by an identifier
 * Examples: ":name", ":age", ":foaf/knows"
 */
export const IRI = Schema.String.pipe(
  Schema.pattern(/^:[a-zA-Z_][a-zA-Z0-9_/-]*$/),
  Schema.annotations({
    identifier: "IRI",
    description: "An IRI/attribute starting with : (e.g., :name, :foaf/knows)",
  }),
);

/**
 * Constant: a literal value (string, number, or boolean)
 */
export const Constant = Schema.Union(Schema.String, Schema.Number, Schema.Boolean).annotations({
  identifier: "Constant",
  description: "A constant value (string, number, or boolean)",
});

/**
 * Term: either a variable or a constant
 */
export const Term = Schema.Union(Variable, Constant).annotations({
  identifier: "Term",
  description: "A term that is either a variable (?x) or a constant value",
});

// =============================================================================
// Triple Pattern
// =============================================================================

/**
 * Triple pattern: [subject, predicate, object]
 * The basic building block of SPARQL queries
 */
export const TriplePattern = Schema.Tuple(Term, Term, Term).annotations({
  identifier: "TriplePattern",
  description: "A triple pattern [subject, predicate, object] for matching triples",
});

// =============================================================================
// Filter Expressions (Simplified)
// =============================================================================

/**
 * Comparison operators for FILTER
 */
export const ComparisonOp = Schema.Literal("=", "!=", "<", ">", "<=", ">=").annotations({
  identifier: "ComparisonOp",
  description: "Comparison operator for FILTER expressions",
});

/**
 * Logical operators for combining filters
 */
export const LogicalOp = Schema.Literal("and", "or", "not").annotations({
  identifier: "LogicalOp",
  description: "Logical operator for combining FILTER expressions",
});

/**
 * Built-in function names for FILTER
 */
export const BuiltInFunction = Schema.Literal(
  "strlen",
  "substr",
  "contains",
  "strstarts",
  "strends",
  "ucase",
  "lcase",
  "concat",
  "regex",
  "abs",
  "round",
  "ceil",
  "floor",
  "bound",
  "notBound",
  "in",
  "notIn",
  "langMatches",
  "isIri",
  "isLiteral",
  "isNumeric",
  "isBlank",
  "lang",
  "datatype",
  "str",
).annotations({
  identifier: "BuiltInFunction",
  description: "Built-in SPARQL function for FILTER expressions",
});

/**
 * Comparison expression: { op, left, right }
 */
export const ComparisonExpr = Schema.Struct({
  op: ComparisonOp,
  left: Term,
  right: Term,
}).annotations({
  identifier: "ComparisonExpr",
  description: "A comparison expression like ?age >= 18",
});

/**
 * Built-in function call: { fn, args }
 */
export const BuiltInCall = Schema.Struct({
  fn: BuiltInFunction,
  args: Schema.Array(Term),
}).annotations({
  identifier: "BuiltInCall",
  description: "A built-in function call like regex(?name, '^A')",
});

/**
 * Filter expression: comparison or built-in call
 * Note: Logical expressions (and/or/not) handled at runtime
 */
export const FilterExpression = Schema.Union(
  ComparisonExpr,
  BuiltInCall,
  // For logical expressions and EXISTS, use Unknown and validate at runtime
  Schema.Unknown,
).annotations({
  identifier: "FilterExpression",
  description: "A FILTER expression",
});

// =============================================================================
// Math and BIND Expressions
// =============================================================================

/**
 * Math operators for BIND expressions
 */
export const MathOp = Schema.Literal("+", "-", "*", "/").annotations({
  identifier: "MathOp",
  description: "Math operator for BIND expressions",
});

/**
 * BIND expression (simplified): term, function call, or math expression
 * Note: Complex nested expressions handled at runtime
 */
export const BindExpression = Schema.Union(
  Term,
  BuiltInCall,
  Schema.Unknown, // Complex expressions validated at runtime
).annotations({
  identifier: "BindExpression",
  description: "An expression for BIND",
});

// =============================================================================
// Property Paths (Simplified)
// =============================================================================

/**
 * Property path: IRI or path object
 * Note: Complex nested paths handled at runtime
 */
export const PropertyPath = Schema.Union(
  IRI,
  Schema.Unknown, // Complex paths validated at runtime
).annotations({
  identifier: "PropertyPath",
  description: "A property path expression",
});

// =============================================================================
// Graph Pattern Elements
// =============================================================================

/**
 * OPTIONAL pattern: { optional: GraphPattern }
 */
export const OptionalPattern = Schema.Struct({
  optional: Schema.Array(Schema.Unknown), // GraphPattern - validated at runtime
}).annotations({
  identifier: "OptionalPattern",
  description: "An OPTIONAL pattern (left outer join)",
});

/**
 * UNION pattern: { union: [GraphPattern, GraphPattern, ...] }
 */
export const UnionPattern = Schema.Struct({
  union: Schema.Array(Schema.Array(Schema.Unknown)), // Array of GraphPatterns
}).annotations({
  identifier: "UnionPattern",
  description: "A UNION pattern (alternatives)",
});

/**
 * FILTER pattern: { filter: FilterExpression }
 */
export const FilterPattern = Schema.Struct({
  filter: FilterExpression,
}).annotations({
  identifier: "FilterPattern",
  description: "A FILTER pattern for filtering results",
});

/**
 * BIND pattern: { bind: { expr, as } }
 */
export const BindPattern = Schema.Struct({
  bind: Schema.Struct({
    expr: BindExpression,
    as: Variable,
  }),
}).annotations({
  identifier: "BindPattern",
  description: "A BIND pattern for computed variables",
});

/**
 * VALUES pattern: { values: { variables, bindings } }
 */
export const ValuesPattern = Schema.Struct({
  values: Schema.Struct({
    variables: Schema.Array(Variable),
    bindings: Schema.Array(
      Schema.Record({ key: Schema.String, value: Schema.Union(Constant, Schema.Null) }),
    ),
  }),
}).annotations({
  identifier: "ValuesPattern",
  description: "A VALUES pattern for inline data",
});

/**
 * MINUS pattern: { minus: GraphPattern }
 */
export const MinusPattern = Schema.Struct({
  minus: Schema.Array(Schema.Unknown), // GraphPattern
}).annotations({
  identifier: "MinusPattern",
  description: "A MINUS pattern for set difference",
});

/**
 * Property path pattern: { subject, path, object }
 */
export const PropertyPathPattern = Schema.Struct({
  subject: Term,
  path: PropertyPath,
  object: Term,
}).annotations({
  identifier: "PropertyPathPattern",
  description: "A property path pattern for traversal",
});

/**
 * Subquery pattern: { subSelect: SparqlQuery }
 */
export const SubSelectPattern = Schema.Struct({
  subSelect: Schema.Unknown, // SparqlQuery - validated at runtime
}).annotations({
  identifier: "SubSelectPattern",
  description: "A nested SELECT subquery",
});

/**
 * Graph pattern element: triple, optional, union, filter, bind, values, minus, path, or subquery
 */
export const GraphPatternElement = Schema.Union(
  TriplePattern,
  OptionalPattern,
  UnionPattern,
  FilterPattern,
  BindPattern,
  ValuesPattern,
  MinusPattern,
  PropertyPathPattern,
  SubSelectPattern,
).annotations({
  identifier: "GraphPatternElement",
  description: "An element of a graph pattern",
});

/**
 * Graph pattern: an array of pattern elements
 */
export const GraphPattern = Schema.Array(GraphPatternElement).annotations({
  identifier: "GraphPattern",
  description: "A graph pattern (array of pattern elements)",
});

// =============================================================================
// Aggregation
// =============================================================================

/**
 * Aggregate operator
 */
export const AggregateOp = Schema.Literal("count", "sum", "avg", "min", "max").annotations({
  identifier: "AggregateOp",
  description: "Aggregation operator",
});

/**
 * Aggregate specification: [operator, sourceVariable, targetVariable]
 */
export const AggregateSpec = Schema.Tuple(AggregateOp, Variable, Variable).annotations({
  identifier: "AggregateSpec",
  description: "An aggregation [op, source, target]",
});

// =============================================================================
// Query Modifiers
// =============================================================================

/**
 * Order direction for sorting results
 */
export const OrderDirection = Schema.Literal("asc", "desc").annotations({
  identifier: "OrderDirection",
  description: "Sort direction",
});

/**
 * Order by specification
 */
export const OrderBySpec = Schema.Struct({
  variable: Variable,
  direction: Schema.optional(OrderDirection),
}).annotations({
  identifier: "OrderBySpec",
  description: "Sorting specification for query results",
});

/**
 * Having clause for filtering aggregated results
 */
export const HavingClause = Schema.Struct({
  op: ComparisonOp,
  left: Term,
  right: Term,
}).annotations({
  identifier: "HavingClause",
  description: "A HAVING clause for filtering aggregated results",
});

// =============================================================================
// Query Forms
// =============================================================================

/**
 * Query form: select, construct, describe, or ask
 */
export const QueryForm = Schema.Literal("select", "construct", "describe", "ask").annotations({
  identifier: "QueryForm",
  description: "The form of the SPARQL query",
});

/**
 * SELECT clause specification
 */
export const SelectClause = Schema.Struct({
  variables: Schema.Array(Variable),
  distinct: Schema.optional(Schema.Boolean),
  reduced: Schema.optional(Schema.Boolean),
}).annotations({
  identifier: "SelectClause",
  description: "SELECT clause specifying variables to return",
});

// =============================================================================
// Main Query Structure
// =============================================================================

/**
 * SPARQL Query: the main query structure
 *
 * Example SELECT query:
 * ```typescript
 * {
 *   form: "select",
 *   select: { variables: ["?name", "?email"] },
 *   where: [
 *     ["?person", ":name", "?name"],
 *     { optional: [["?person", ":email", "?email"]] }
 *   ]
 * }
 * ```
 */
export const SparqlQuery = Schema.Struct({
  form: QueryForm,
  select: Schema.optional(SelectClause),
  where: GraphPattern,
  construct: Schema.optional(Schema.Array(TriplePattern)),
  describe: Schema.optional(Schema.Array(Term)),
  aggregate: Schema.optional(Schema.Array(AggregateSpec)),
  groupBy: Schema.optional(Schema.Array(Variable)),
  having: Schema.optional(Schema.Array(HavingClause)),
  orderBy: Schema.optional(Schema.Array(OrderBySpec)),
  limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  offset: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
}).annotations({
  identifier: "SparqlQuery",
  description: "A SPARQL query with form, select/construct/describe, where, and optional modifiers",
});

// =============================================================================
// Type Exports
// =============================================================================

export type Variable = typeof Variable.Type;
export type IRI = typeof IRI.Type;
export type Constant = typeof Constant.Type;
export type Term = typeof Term.Type;
export type TriplePattern = typeof TriplePattern.Type;
export type ComparisonOp = typeof ComparisonOp.Type;
export type LogicalOp = typeof LogicalOp.Type;
export type BuiltInFunction = typeof BuiltInFunction.Type;
export type ComparisonExpr = typeof ComparisonExpr.Type;
export type BuiltInCall = typeof BuiltInCall.Type;
export type FilterExpression = typeof FilterExpression.Type;
export type MathOp = typeof MathOp.Type;
export type BindExpression = typeof BindExpression.Type;
export type PropertyPath = typeof PropertyPath.Type;
export type OptionalPattern = typeof OptionalPattern.Type;
export type UnionPattern = typeof UnionPattern.Type;
export type FilterPattern = typeof FilterPattern.Type;
export type BindPattern = typeof BindPattern.Type;
export type ValuesPattern = typeof ValuesPattern.Type;
export type MinusPattern = typeof MinusPattern.Type;
export type PropertyPathPattern = typeof PropertyPathPattern.Type;
export type SubSelectPattern = typeof SubSelectPattern.Type;
export type GraphPatternElement = typeof GraphPatternElement.Type;
export type GraphPattern = typeof GraphPattern.Type;
export type AggregateOp = typeof AggregateOp.Type;
export type AggregateSpec = typeof AggregateSpec.Type;
export type OrderDirection = typeof OrderDirection.Type;
export type OrderBySpec = typeof OrderBySpec.Type;
export type HavingClause = typeof HavingClause.Type;
export type QueryForm = typeof QueryForm.Type;
export type SelectClause = typeof SelectClause.Type;
export type SparqlQuery = typeof SparqlQuery.Type;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a term is a variable (starts with ?)
 */
export const isVariable = (term: unknown): term is string =>
  typeof term === "string" && term.startsWith("?");

/**
 * Check if a term is an IRI (starts with :)
 */
export const isIRI = (term: unknown): term is string =>
  typeof term === "string" && term.startsWith(":");

/**
 * Check if a pattern element is a triple pattern (array of 3 terms)
 */
export const isTriplePattern = (element: unknown): element is TriplePattern =>
  Array.isArray(element) && element.length === 3;

/**
 * Check if a pattern element is an OPTIONAL pattern
 */
export const isOptionalPattern = (element: unknown): element is OptionalPattern =>
  typeof element === "object" &&
  element !== null &&
  !Array.isArray(element) &&
  "optional" in element;

/**
 * Check if a pattern element is a UNION pattern
 */
export const isUnionPattern = (element: unknown): element is UnionPattern =>
  typeof element === "object" && element !== null && !Array.isArray(element) && "union" in element;

/**
 * Check if a pattern element is a FILTER pattern
 */
export const isFilterPattern = (element: unknown): element is FilterPattern =>
  typeof element === "object" && element !== null && !Array.isArray(element) && "filter" in element;

/**
 * Check if a pattern element is a BIND pattern
 */
export const isBindPattern = (element: unknown): element is BindPattern =>
  typeof element === "object" && element !== null && !Array.isArray(element) && "bind" in element;

/**
 * Check if a pattern element is a VALUES pattern
 */
export const isValuesPattern = (element: unknown): element is ValuesPattern =>
  typeof element === "object" && element !== null && !Array.isArray(element) && "values" in element;

/**
 * Check if a pattern element is a MINUS pattern
 */
export const isMinusPattern = (element: unknown): element is MinusPattern =>
  typeof element === "object" && element !== null && !Array.isArray(element) && "minus" in element;

/**
 * Check if a pattern element is a property path pattern
 */
export const isPropertyPathPattern = (element: unknown): element is PropertyPathPattern =>
  typeof element === "object" && element !== null && !Array.isArray(element) && "path" in element;

/**
 * Check if a pattern element is a subquery pattern
 */
export const isSubSelectPattern = (element: unknown): element is SubSelectPattern =>
  typeof element === "object" &&
  element !== null &&
  !Array.isArray(element) &&
  "subSelect" in element;

/**
 * Check if a filter expression is a comparison
 */
export const isComparisonExpr = (expr: unknown): expr is ComparisonExpr =>
  typeof expr === "object" &&
  expr !== null &&
  "op" in expr &&
  "left" in expr &&
  "right" in expr &&
  ["=", "!=", "<", ">", "<=", ">="].includes((expr as { op: string }).op);

/**
 * Check if a filter expression is a built-in function call
 */
export const isBuiltInCall = (expr: unknown): expr is BuiltInCall =>
  typeof expr === "object" && expr !== null && "fn" in expr && "args" in expr;

/**
 * Check if a filter expression is a logical expression
 */
export const isLogicalExpr = (
  expr: unknown,
): expr is { op: "and" | "or" | "not"; args: unknown[] } =>
  typeof expr === "object" &&
  expr !== null &&
  "op" in expr &&
  "args" in expr &&
  ["and", "or", "not"].includes((expr as { op: string }).op);

/**
 * Check if a filter expression is an EXISTS expression
 */
export const isExistsExpr = (
  expr: unknown,
): expr is { fn: "exists" | "notExists"; pattern: unknown[] } =>
  typeof expr === "object" && expr !== null && "fn" in expr && "pattern" in expr;

/**
 * Check if a property path is a simple IRI (string)
 */
export const isSimplePath = (path: unknown): path is string => typeof path === "string";

/**
 * Check if a property path is a sequence
 */
export const isSeqPath = (path: unknown): path is { seq: unknown[] } =>
  typeof path === "object" && path !== null && "seq" in path;

/**
 * Check if a property path is an alternative
 */
export const isAltPath = (path: unknown): path is { alt: unknown[] } =>
  typeof path === "object" && path !== null && "alt" in path;

/**
 * Check if a property path is an inverse
 */
export const isInversePath = (path: unknown): path is { inverse: unknown } =>
  typeof path === "object" && path !== null && "inverse" in path;

/**
 * Check if a property path is zero-or-more
 */
export const isZeroOrMorePath = (path: unknown): path is { zeroOrMore: unknown } =>
  typeof path === "object" && path !== null && "zeroOrMore" in path;

/**
 * Check if a property path is one-or-more
 */
export const isOneOrMorePath = (path: unknown): path is { oneOrMore: unknown } =>
  typeof path === "object" && path !== null && "oneOrMore" in path;

/**
 * Check if a property path is zero-or-one
 */
export const isZeroOrOnePath = (path: unknown): path is { zeroOrOne: unknown } =>
  typeof path === "object" && path !== null && "zeroOrOne" in path;

// Additional types for complex expressions that are validated at runtime
export type LogicalExpr = { op: "and" | "or" | "not"; args: FilterExpression[] };
export type ExistsExpr = { fn: "exists" | "notExists"; pattern: GraphPatternElement[] };
