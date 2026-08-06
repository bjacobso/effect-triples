/**
 * SQL Compiler for Datalog Queries
 *
 * Compiles Datalog queries directly to SQL for efficient execution.
 * This replaces the in-memory engine for production use.
 */

import { Data } from "effect";
import {
  isVariable,
  isRuleApplication,
  isTypedConstant,
  isPredicateClause,
  isNotClause,
  normalizeOrAlternatives,
} from "./schema.js";
import type { SqlDialect } from "../dialects/index.js";
import { SqliteDialect } from "../dialects/sqlite.js";
import { createParamCollector, type ParamCollector } from "../params.js";
import type {
  Constant,
  Term,
  PatternClause,
  PredicateClause,
  NotClause,
  OrClause,
  RuleApplication,
  LinkClause,
  Rule,
  Clause,
  DatalogQuery,
  OrderBySpec,
  HavingClause,
} from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Tracks where a variable is bound in the SQL query
 */
type TripleBindingPosition = "entity" | "attribute" | "value" | "tx";
type RuleBindingPosition = "arg1" | "arg2";

type VariableBinding =
  | {
      readonly _tag: "Triple";
      readonly alias: string;
      readonly position: TripleBindingPosition;
    }
  | {
      readonly _tag: "Rule";
      readonly alias: string;
      readonly position: RuleBindingPosition;
    };

const tripleBinding = (alias: string, position: TripleBindingPosition): VariableBinding => ({
  _tag: "Triple",
  alias,
  position,
});

const ruleBinding = (alias: string, position: RuleBindingPosition): VariableBinding => ({
  _tag: "Rule",
  alias,
  position,
});

type InternalClause = Data.TaggedEnum<{
  Pattern: { readonly pattern: PatternClause };
  Predicate: { readonly predicate: PredicateClause };
  Not: { readonly notClause: NotClause };
  Or: { readonly orClause: OrClause };
  Link: { readonly linkClause: LinkClause };
  RuleCall: { readonly ruleApplication: RuleApplication };
}>;

const InternalClause = Data.taggedEnum<InternalClause>();

interface ClassifiedClauses {
  patterns: PatternClause[];
  predicates: PredicateClause[];
  notClauses: NotClause[];
  orClauses: OrClause[];
  linkClauses: LinkClause[];
  ruleApplications: RuleApplication[];
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
  /** Maps aggregate target variables to their SQL expressions (for HAVING/ORDER BY) */
  aggregateExpressions: Map<string, string>;
  /** Parameter collector for parameterized queries */
  collector: ParamCollector;
}

/**
 * Query compilation and execution metrics
 */
export interface QueryMetrics {
  // SQL Complexity
  joinCount: number;
  whereConditionCount: number;
  subqueryCount: number; // NOT EXISTS clauses
  cteCount: number; // Common Table Expressions (recursive queries)
  sqlLength: number;
  paramCount: number;

  // Clause Breakdown
  patternCount: number;
  predicateCount: number;
  notClauseCount: number;
  orClauseCount: number;
  linkClauseCount: number;

  // Features Used
  hasAggregation: boolean;
  isRecursive: boolean;
  aggregateOps: string[]; // e.g., ["count", "sum"]

  // Compilation Timing
  compilationTimeMs: number;
}

/**
 * Result of compiling a Datalog query
 */
export interface CompiledQuery {
  sql: string;
  /** Parameters for the parameterized query */
  params: unknown[];
  /** Maps result column names to variable names */
  columnMap: Map<string, string>;
  /** Optional metrics - only included when debug=true */
  metrics?: QueryMetrics;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Escape a string value for safe SQL interpolation.
 * Used only for rule definitions (CTEs) which are developer-defined.
 * TODO: Refactor rule compilation to use parameterized queries.
 */
const escapeStringForRules = (s: string): string => s.replace(/'/g, "''");

/**
 * Format a constant value for SQL using string escaping.
 * Used only for rule definitions (CTEs) which are developer-defined.
 * TODO: Refactor rule compilation to use parameterized queries.
 */
const formatValueForRules = (value: Constant): string => {
  if (isTypedConstant(value)) return `'${escapeStringForRules(value.value)}'`;
  if (typeof value === "string") return `'${escapeStringForRules(value)}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
};

/**
 * Get the SQL column name for a value based on its type
 */
const getValueColumn = (value: Constant): string => {
  if (isTypedConstant(value)) return "value_string";
  if (typeof value === "number") return "value_number";
  if (typeof value === "boolean") return "value_boolean";
  return "value_string";
};

/**
 * Format a constant value for SQL using parameterized queries.
 * Uses the ParamCollector to add the value and return a placeholder.
 */
const formatValue = (value: Constant, ctx: CompilerContext): string => {
  if (isTypedConstant(value)) return ctx.collector.add(value.value);
  return ctx.collector.add(value);
};

/**
 * Get the column expression for a term in a given alias
 */
const getColumnForPosition = (
  alias: string,
  position: TripleBindingPosition,
  valueColumn?: "value_string" | "value_number" | "value_boolean",
): string => {
  switch (position) {
    case "entity":
      return `${alias}.entity_id`;
    case "attribute":
      return `${alias}.attribute`;
    case "value":
      return valueColumn ? `${alias}.${valueColumn}` : `${alias}.value_string`;
    case "tx":
      return `${alias}.tx_id`;
  }
};

type BindingValueMode = "raw" | "string" | "number" | "boolean" | "coalesce";

const resolveBinding = (
  binding: VariableBinding,
  options: { valueMode?: BindingValueMode } = {},
): string => {
  const valueMode = options.valueMode ?? "raw";

  if (binding._tag === "Rule") {
    if (valueMode === "number") {
      return `CAST(${binding.alias}.${binding.position} AS REAL)`;
    }
    return `${binding.alias}.${binding.position}`;
  }

  if (binding.position === "value") {
    if (valueMode === "coalesce") {
      return `COALESCE(${binding.alias}.value_string, CAST(${binding.alias}.value_number AS TEXT), CAST(${binding.alias}.value_boolean AS TEXT))`;
    }
    if (valueMode === "number") {
      return `${binding.alias}.value_number`;
    }
    if (valueMode === "boolean") {
      return `${binding.alias}.value_boolean`;
    }
    return `${binding.alias}.value_string`;
  }

  return getColumnForPosition(binding.alias, binding.position);
};

const isValueLikeBinding = (binding: VariableBinding): boolean => {
  return (
    (binding._tag === "Triple" && binding.position === "value") ||
    (binding._tag === "Rule" && binding.position === "arg2")
  );
};

const predicateOperators = new Set<PredicateClause[0]>([">", ">=", "<", "<=", "=", "!="]);

const parseClause = (
  clause: Clause,
  options: { allowRuleApplications: boolean },
): InternalClause => {
  const head = clause[0];

  if (typeof head === "string" && predicateOperators.has(head as PredicateClause[0])) {
    if (clause.length !== 3) {
      throw new Error(`Invalid predicate clause arity: ${JSON.stringify(clause)}`);
    }
    return InternalClause.Predicate({ predicate: clause as PredicateClause });
  }

  if (head === "not") {
    if (clause.length < 2) {
      throw new Error(`Invalid not clause arity: ${JSON.stringify(clause)}`);
    }
    return InternalClause.Not({ notClause: clause as NotClause });
  }

  if (head === "or") {
    const alternatives = normalizeOrAlternatives(clause as OrClause | readonly ["or", ...Clause[]]);
    return InternalClause.Or({ orClause: ["or", alternatives] as OrClause });
  }

  if (head === "link") {
    if (clause.length !== 4) {
      throw new Error(`Invalid link clause arity: ${JSON.stringify(clause)}`);
    }
    return InternalClause.Link({ linkClause: clause as LinkClause });
  }

  if (clause.length < 3 || clause.length > 4) {
    throw new Error(`Invalid clause arity: ${JSON.stringify(clause)}`);
  }

  if (clause.length === 3 && isRuleApplication(clause as Clause)) {
    if (!options.allowRuleApplications) {
      throw new Error(
        `Rule application "${clause[0]}" requires compileWithRules() and rule definitions`,
      );
    }
    return InternalClause.RuleCall({ ruleApplication: clause as RuleApplication });
  }

  return InternalClause.Pattern({ pattern: clause as PatternClause });
};

const classifyClauses = (
  where: readonly Clause[],
  options: { allowRuleApplications: boolean },
): ClassifiedClauses => {
  const classified: ClassifiedClauses = {
    patterns: [],
    predicates: [],
    notClauses: [],
    orClauses: [],
    linkClauses: [],
    ruleApplications: [],
  };

  for (const clause of where) {
    const parsed = parseClause(clause, options);
    switch (parsed._tag) {
      case "Pattern":
        classified.patterns.push(parsed.pattern);
        break;
      case "Predicate":
        classified.predicates.push(parsed.predicate);
        break;
      case "Not":
        classified.notClauses.push(parsed.notClause);
        break;
      case "Or":
        classified.orClauses.push(parsed.orClause);
        break;
      case "Link":
        classified.linkClauses.push(parsed.linkClause);
        break;
      case "RuleCall":
        classified.ruleApplications.push(parsed.ruleApplication);
        break;
    }
  }

  return classified;
};

/**
 * Infer value type from a constant
 */
const inferValueType = (value: Constant): string => {
  if (isTypedConstant(value)) return value.type;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
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
  aggregateExpressions: new Map(),
  collector: createParamCollector(dialect),
});

/**
 * Get the next table alias
 */
const nextAlias = (ctx: CompilerContext): string => {
  const alias = `t${ctx.aliasCounter}`;
  ctx.aliasCounter++;
  return alias;
};

// =============================================================================
// Pattern Compilation
// =============================================================================

/**
 * Compile a single pattern clause to SQL
 * Returns the table alias used for this pattern
 *
 * Supports both 3-tuple [entity, attribute, value] and
 * 4-tuple [entity, attribute, value, tx] patterns
 */
const compilePattern = (
  pattern: PatternClause,
  ctx: CompilerContext,
  isFirstPattern: boolean,
): string => {
  const [entity, attribute, value] = pattern;
  // Optional 4th element is the transaction binding
  const tx = pattern.length === 4 ? pattern[3] : undefined;
  const alias = nextAlias(ctx);

  // Build JOIN or FROM clause
  if (isFirstPattern) {
    // First pattern goes in FROM (no JOIN needed)
    ctx.conditions.push(`${alias}.retracted_at IS NULL`);
  } else {
    // Subsequent patterns are JOINed
    // Find the join condition based on shared variables
    let joinCondition = `${alias}.retracted_at IS NULL`;

    // Check if entity is a bound variable
    if (isVariable(entity) && ctx.bindings.has(entity)) {
      const binding = ctx.bindings.get(entity)!;
      const boundCol = resolveBinding(binding);
      joinCondition = `${alias}.entity_id = ${boundCol} AND ${joinCondition}`;
    }

    // Check if value is a bound variable (for ref joins)
    if (isVariable(value) && ctx.bindings.has(value)) {
      const binding = ctx.bindings.get(value)!;
      const boundCol = resolveBinding(binding, { valueMode: "string" });
      // If the bound variable is value-like, it could be a reference
      if (isValueLikeBinding(binding)) {
        joinCondition = `${alias}.entity_id = ${boundCol} AND ${joinCondition}`;
      }
    }

    ctx.joins.push(`JOIN triples ${alias} ON ${joinCondition}`);
  }

  // Process entity term
  if (isVariable(entity)) {
    if (!ctx.bindings.has(entity)) {
      ctx.bindings.set(entity, tripleBinding(alias, "entity"));
    } else {
      // Already bound - add equality condition for join
      // (supplements the JOIN condition from lines above for robustness)
      const binding = ctx.bindings.get(entity)!;
      const boundCol = resolveBinding(binding, { valueMode: "string" });
      ctx.conditions.push(`${alias}.entity_id = ${boundCol}`);
    }
  } else {
    ctx.conditions.push(`${alias}.entity_id = ${formatValue(entity, ctx)}`);
  }

  // Process attribute term
  if (isVariable(attribute)) {
    if (!ctx.bindings.has(attribute)) {
      ctx.bindings.set(attribute, tripleBinding(alias, "attribute"));
    } else {
      // Already bound - add equality condition for join
      const binding = ctx.bindings.get(attribute)!;
      const boundCol = resolveBinding(binding, { valueMode: "string" });
      ctx.conditions.push(`${alias}.attribute = ${boundCol}`);
    }
  } else {
    ctx.conditions.push(`${alias}.attribute = ${formatValue(attribute, ctx)}`);
  }

  // Process value term
  if (isVariable(value)) {
    if (!ctx.bindings.has(value)) {
      ctx.bindings.set(value, tripleBinding(alias, "value"));
    } else {
      // Already bound - add equality condition for join
      const binding = ctx.bindings.get(value)!;
      const boundCol = resolveBinding(binding, { valueMode: "string" });
      ctx.conditions.push(`${alias}.value_string = ${boundCol}`);
    }
  } else {
    const valueCol = getValueColumn(value);
    const valueType = inferValueType(value);
    ctx.conditions.push(`${alias}.${valueCol} = ${formatValue(value, ctx)}`);
    ctx.conditions.push(`${alias}.value_type = ${formatValue(valueType, ctx)}`);
  }

  // Process tx term (optional 4th element)
  if (tx !== undefined) {
    if (isVariable(tx)) {
      if (!ctx.bindings.has(tx)) {
        // First occurrence - bind to tx_id column
        ctx.bindings.set(tx, tripleBinding(alias, "tx"));
      } else {
        // Already bound - add equality condition for join
        const binding = ctx.bindings.get(tx)!;
        const boundCol = resolveBinding(binding);
        ctx.conditions.push(`${alias}.tx_id = ${boundCol}`);
      }
    } else {
      // tx is a constant - filter by specific transaction ID
      ctx.conditions.push(`${alias}.tx_id = ${formatValue(tx, ctx)}`);
    }
  }

  return alias;
};

// =============================================================================
// Predicate Compilation
// =============================================================================

/**
 * Compile a predicate clause to SQL WHERE condition
 */
const compilePredicateCondition = (predicate: PredicateClause, ctx: CompilerContext): string => {
  const [op, left, right] = predicate;
  const valueMode: BindingValueMode = op === "=" || op === "!=" ? "string" : "number";

  // Resolve left term
  let leftExpr: string;
  if (isVariable(left)) {
    const binding = ctx.bindings.get(left);
    if (!binding) {
      throw new Error(`Unbound variable in predicate: ${left}`);
    }
    leftExpr = resolveBinding(binding, { valueMode });
  } else {
    leftExpr = formatValue(left, ctx);
  }

  // Resolve right term
  let rightExpr: string;
  if (isVariable(right)) {
    const binding = ctx.bindings.get(right);
    if (!binding) {
      throw new Error(`Unbound variable in predicate: ${right}`);
    }
    rightExpr = resolveBinding(binding, { valueMode });
  } else {
    rightExpr = formatValue(right, ctx);
  }

  // Map operator
  const sqlOp = op === "!=" ? "<>" : op;

  return `${leftExpr} ${sqlOp} ${rightExpr}`;
};

const compilePredicate = (predicate: PredicateClause, ctx: CompilerContext): void => {
  ctx.conditions.push(compilePredicateCondition(predicate, ctx));
};

// =============================================================================
// Not Clause Compilation
// =============================================================================

/**
 * Compile a NOT clause to SQL NOT EXISTS subquery
 */
/**
 * Build conditions for a single pattern within a NOT EXISTS subquery.
 * Returns conditions that constrain the given alias.
 */
const compileNotPattern = (
  pattern: PatternClause,
  alias: string,
  ctx: CompilerContext,
  localBindings: Map<string, string>,
): string[] => {
  const [entity, attribute, value] = pattern;
  const tx = pattern.length === 4 ? pattern[3] : undefined;
  const conditions: string[] = [`${alias}.retracted_at IS NULL`];

  // Handle entity
  if (isVariable(entity)) {
    const outerBinding = ctx.bindings.get(entity);
    const localBinding = localBindings.get(entity);
    if (localBinding) {
      // Variable already bound in a prior pattern within this not — join
      conditions.push(`${alias}.entity_id = ${localBinding}`);
    } else if (outerBinding) {
      // Variable bound in outer query — correlate
      conditions.push(`${alias}.entity_id = ${resolveBinding(outerBinding)}`);
    }
    // Record local binding for subsequent patterns
    localBindings.set(entity, `${alias}.entity_id`);
  } else {
    conditions.push(`${alias}.entity_id = ${formatValue(entity, ctx)}`);
  }

  // Handle attribute
  if (isVariable(attribute)) {
    const outerBinding = ctx.bindings.get(attribute);
    const localBinding = localBindings.get(attribute);
    if (localBinding) {
      conditions.push(`${alias}.attribute = ${localBinding}`);
    } else if (outerBinding) {
      conditions.push(`${alias}.attribute = ${resolveBinding(outerBinding)}`);
    }
    localBindings.set(attribute, `${alias}.attribute`);
  } else {
    conditions.push(`${alias}.attribute = ${formatValue(attribute, ctx)}`);
  }

  // Handle value
  if (isVariable(value)) {
    const outerBinding = ctx.bindings.get(value);
    const localBinding = localBindings.get(value);
    if (localBinding) {
      conditions.push(`${alias}.value_string = ${localBinding}`);
    } else if (outerBinding) {
      conditions.push(
        `${alias}.value_string = ${resolveBinding(outerBinding, { valueMode: "string" })}`,
      );
    }
    localBindings.set(value, `${alias}.value_string`);
  } else {
    const valueCol = getValueColumn(value);
    conditions.push(`${alias}.${valueCol} = ${formatValue(value, ctx)}`);
  }

  if (tx !== undefined) {
    if (isVariable(tx)) {
      const outerBinding = ctx.bindings.get(tx);
      const localBinding = localBindings.get(tx);
      if (localBinding) {
        conditions.push(`${alias}.tx_id = ${localBinding}`);
      } else if (outerBinding) {
        conditions.push(`${alias}.tx_id = ${resolveBinding(outerBinding)}`);
      }
      localBindings.set(tx, `${alias}.tx_id`);
    } else {
      conditions.push(`${alias}.tx_id = ${formatValue(tx, ctx)}`);
    }
  }

  return conditions;
};

/**
 * Compile a predicate clause within a NOT EXISTS subquery.
 * Predicates reference local bindings (from patterns within the same not).
 */
const compileNotPredicate = (
  clause: PredicateClause,
  ctx: CompilerContext,
  localBindings: Map<string, string>,
): string => {
  const [op, left, right] = clause;
  const valueMode: BindingValueMode = op === "=" || op === "!=" ? "string" : "number";

  const resolveNotTerm = (term: Term): string => {
    if (isVariable(term)) {
      const local = localBindings.get(term);
      if (local) return local;
      const outer = ctx.bindings.get(term);
      if (outer) return resolveBinding(outer, { valueMode });
      throw new Error(`Unbound variable in not predicate: ${term}`);
    }
    return formatValue(term, ctx);
  };

  const sqlOp =
    op === "="
      ? "="
      : op === "!="
        ? "!="
        : op === ">"
          ? ">"
          : op === ">="
            ? ">="
            : op === "<"
              ? "<"
              : "<=";
  return `${resolveNotTerm(left)} ${sqlOp} ${resolveNotTerm(right)}`;
};

const compileNotCondition = (notClause: NotClause, ctx: CompilerContext): string => {
  // Extract inner clauses: ["not", c1] or ["not", c1, c2, ...]
  const innerClauses = notClause.slice(1) as (PatternClause | PredicateClause)[];

  // Separate patterns from predicates
  const patterns: PatternClause[] = [];
  const predicates: PredicateClause[] = [];
  for (const clause of innerClauses) {
    if (isPredicateClause(clause as Clause)) {
      predicates.push(clause as PredicateClause);
    } else {
      patterns.push(clause as PatternClause);
    }
  }

  const localBindings = new Map<string, string>();
  const allConditions: string[] = [];
  const fromParts: string[] = [];

  for (const pattern of patterns) {
    const alias = nextAlias(ctx);
    fromParts.push(`triples ${alias}`);
    const conditions = compileNotPattern(pattern, alias, ctx, localBindings);
    allConditions.push(...conditions);
  }

  // Compile predicates using local bindings
  for (const pred of predicates) {
    allConditions.push(compileNotPredicate(pred, ctx, localBindings));
  }

  if (patterns.length === 0) {
    if (allConditions.length === 0) {
      throw new Error(`Invalid not clause arity: ${JSON.stringify(notClause)}`);
    }
    return `NOT (${allConditions.join(" AND ")})`;
  }

  const fromClause = fromParts.join(", ");
  return `NOT EXISTS (SELECT 1 FROM ${fromClause} WHERE ${allConditions.join(" AND ")})`;
};

const compileNot = (notClause: NotClause, ctx: CompilerContext): void => {
  ctx.conditions.push(compileNotCondition(notClause, ctx));
};

// =============================================================================
// Or Clause Compilation
// =============================================================================

/**
 * Compile an OR clause to SQL OR conditions.
 * Or alternatives are filter/existence checks and do not bind variables outward.
 */
const compileOr = (orClause: OrClause, ctx: CompilerContext): void => {
  const alternatives = normalizeOrAlternatives(orClause);
  if (alternatives.length === 0) return;

  const orConditions = alternatives.map((alternative) => {
    if (isPredicateClause(alternative as Clause)) {
      return `(${compilePredicateCondition(alternative as PredicateClause, ctx)})`;
    }
    if (isNotClause(alternative as Clause)) {
      return `(${compileNotCondition(alternative as NotClause, ctx)})`;
    }

    const alias = nextAlias(ctx);
    const localBindings = new Map<string, string>();
    const conditions = compileNotPattern(alternative as PatternClause, alias, ctx, localBindings);
    return `(EXISTS (SELECT 1 FROM triples ${alias} WHERE ${conditions.join(" AND ")}))`;
  });

  if (orConditions.length > 0) {
    ctx.conditions.push(`(${orConditions.join(" OR ")})`);
  }
};

// =============================================================================
// Link Clause Compilation
// =============================================================================

/**
 * Compile a LINK clause to SQL JOINs and WHERE conditions
 *
 * LinkClause format: ["link", relationshipType, source, target, properties?]
 *
 * This expands to queries against the _rel/{relationshipType}/* entities:
 * - :_schema/type = "_Link"
 * - :_rel/type = relationshipType
 * - :_rel/source = source (ref)
 * - :_rel/target = target (ref)
 * - Plus any property bindings
 */
const compileLinkClause = (linkClause: LinkClause, ctx: CompilerContext): void => {
  const [, relationshipType, source, target] = linkClause;

  // Create aliases for each link attribute we need to query
  const typeAlias = nextAlias(ctx);
  const sourceAlias = nextAlias(ctx);
  const targetAlias = nextAlias(ctx);

  // Join for :_rel/type = relationshipType (this anchors the link entity)
  ctx.joins.push(`JOIN triples ${typeAlias} ON ${typeAlias}.retracted_at IS NULL`);
  ctx.conditions.push(`${typeAlias}.attribute = ${formatValue(":_rel/type", ctx)}`);
  ctx.conditions.push(`${typeAlias}.value_string = ${formatValue(String(relationshipType), ctx)}`);

  // Join for :_rel/source
  ctx.joins.push(
    `JOIN triples ${sourceAlias} ON ${sourceAlias}.entity_id = ${typeAlias}.entity_id AND ${sourceAlias}.retracted_at IS NULL`,
  );
  ctx.conditions.push(`${sourceAlias}.attribute = ${formatValue(":_rel/source", ctx)}`);

  // Handle source term
  if (isVariable(source)) {
    if (ctx.bindings.has(source)) {
      // Source is already bound - add equality condition
      const binding = ctx.bindings.get(source)!;
      const boundCol = resolveBinding(binding, { valueMode: "string" });
      ctx.conditions.push(`${sourceAlias}.value_string = ${boundCol}`);
    } else {
      // Bind the source variable
      ctx.bindings.set(source, tripleBinding(sourceAlias, "value"));
    }
  } else {
    ctx.conditions.push(`${sourceAlias}.value_string = ${formatValue(source, ctx)}`);
  }

  // Join for :_rel/target
  ctx.joins.push(
    `JOIN triples ${targetAlias} ON ${targetAlias}.entity_id = ${typeAlias}.entity_id AND ${targetAlias}.retracted_at IS NULL`,
  );
  ctx.conditions.push(`${targetAlias}.attribute = ${formatValue(":_rel/target", ctx)}`);

  // Handle target term
  if (isVariable(target)) {
    if (ctx.bindings.has(target)) {
      // Target is already bound - add equality condition
      const binding = ctx.bindings.get(target)!;
      const boundCol = resolveBinding(binding, { valueMode: "string" });
      ctx.conditions.push(`${targetAlias}.value_string = ${boundCol}`);
    } else {
      // Bind the target variable
      ctx.bindings.set(target, tripleBinding(targetAlias, "value"));
    }
  } else {
    ctx.conditions.push(`${targetAlias}.value_string = ${formatValue(target, ctx)}`);
  }
};

// =============================================================================
// HAVING, ORDER BY, LIMIT/OFFSET Helpers
// =============================================================================

/**
 * Get a column expression for a variable binding (handles value coalesce and tx)
 */
const getColumnExpression = (binding: VariableBinding): string => {
  return resolveBinding(binding, { valueMode: "coalesce" });
};

const optionalProjectionExpression = (
  variable: string,
  optionalProjection: OptionalProjectionSpec | undefined,
  ctx: CompilerContext,
): string | null => {
  if (!optionalProjection) return null;

  const projection = optionalProjection.fields.find((field) => field.variable === variable);
  if (!projection) return null;

  const rowBinding = ctx.bindings.get(optionalProjection.rowBinding);
  if (!rowBinding) return null;

  const entityExpr = resolveBinding(rowBinding, { valueMode: "string" });
  const attributeExpr = `'${escapeStringForRules(projection.attribute)}'`;

  return `(
    SELECT COALESCE(opt.value_string, CAST(opt.value_number AS TEXT), CAST(opt.value_boolean AS TEXT))
    FROM triples opt
    WHERE opt.entity_id = ${entityExpr}
      AND opt.attribute = ${attributeExpr}
      AND opt.retracted_at IS NULL
    LIMIT 1
  )`;
};

/**
 * Resolve a term in HAVING/ORDER BY context
 * Checks aggregate expressions first, then falls back to regular bindings
 */
const resolveTermExpression = (term: Term, ctx: CompilerContext, clauseName: string): string => {
  if (isVariable(term)) {
    // Check if it's an aggregate target variable
    const aggExpr = ctx.aggregateExpressions.get(term);
    if (aggExpr) {
      return aggExpr;
    }
    // Otherwise resolve as regular binding
    const binding = ctx.bindings.get(term);
    if (!binding) {
      throw new Error(`Unbound variable in ${clauseName}: ${term}`);
    }
    return getColumnExpression(binding);
  }
  return formatValue(term, ctx);
};

/**
 * Build the HAVING clause from having specs
 */
const buildHavingClause = (
  having: readonly HavingClause[] | undefined,
  ctx: CompilerContext,
): string => {
  if (!having || having.length === 0) {
    return "";
  }

  const conditions = having.map(([op, left, right]) => {
    const leftExpr = resolveTermExpression(left, ctx, "HAVING");
    const rightExpr = resolveTermExpression(right, ctx, "HAVING");
    const sqlOp = op === "!=" ? "<>" : op;
    return `${leftExpr} ${sqlOp} ${rightExpr}`;
  });

  return `HAVING ${conditions.join(" AND ")}`;
};

/**
 * Build the ORDER BY clause
 */
const buildOrderByClause = (
  orderBy: readonly OrderBySpec[] | undefined,
  ctx: CompilerContext,
): string => {
  if (!orderBy || orderBy.length === 0) {
    return "";
  }

  const parts = orderBy.map(({ variable, direction = "asc" }) => {
    const expr = resolveTermExpression(variable, ctx, "ORDER BY");
    return `${expr} ${direction.toUpperCase()}`;
  });

  return `ORDER BY ${parts.join(", ")}`;
};

/**
 * Build the LIMIT/OFFSET clause
 */
const buildLimitClause = (
  limit: number | undefined,
  offset: number | undefined,
  dialect: SqlDialect = SqliteDialect,
): string => {
  return dialect.limitOffset(limit, offset);
};

interface SelectAndGroupByResult {
  columnMap: Map<string, string>;
  selectParts: string[];
  groupByClause: string;
  hasAggregates: boolean;
  aggregateOps: string[];
}

type OptionalProjectionSpec = NonNullable<DatalogQuery["optionalProjection"]>;

const buildSelectAndGroupBy = (
  find: readonly Term[],
  aggregate: readonly (readonly [string, string, string])[] | undefined,
  optionalProjection: OptionalProjectionSpec | undefined,
  ctx: CompilerContext,
): SelectAndGroupByResult => {
  const columnMap = new Map<string, string>();
  const selectParts: string[] = [];
  const hasAggregates = Boolean(aggregate && aggregate.length > 0);
  const aggregateTargets = new Set<string>();
  const aggregateOps: string[] = [];

  if (hasAggregates) {
    for (const [op, sourceVar, targetVar] of aggregate!) {
      aggregateTargets.add(targetVar);
      aggregateOps.push(op);

      const sourceBinding = ctx.bindings.get(sourceVar);
      if (!sourceBinding) {
        throw new Error(`Unbound variable in aggregate: ${sourceVar}`);
      }

      const colName = `"${targetVar}"`;
      const entityCol = resolveBinding(sourceBinding, { valueMode: "string" });
      const numericCol = resolveBinding(sourceBinding, { valueMode: "number" });

      let aggExpr: string;
      switch (op) {
        case "count":
          aggExpr = `COUNT(DISTINCT ${entityCol})`;
          break;
        case "sum":
          aggExpr = `SUM(${numericCol})`;
          break;
        case "avg":
          aggExpr = `AVG(${numericCol})`;
          break;
        case "min":
          aggExpr = `MIN(${numericCol})`;
          break;
        case "max":
          aggExpr = `MAX(${numericCol})`;
          break;
        default:
          throw new Error(`Unknown aggregate operator: ${op}`);
      }

      ctx.aggregateExpressions.set(targetVar, aggExpr);
      selectParts.push(`${aggExpr} AS ${colName}`);
      columnMap.set(targetVar, targetVar);
    }
  }

  for (const term of find) {
    if (isVariable(term)) {
      if (aggregateTargets.has(term)) continue;

      const binding = ctx.bindings.get(term);
      if (!binding) {
        const projectionExpr = optionalProjectionExpression(term, optionalProjection, ctx);
        if (projectionExpr) {
          const colName = `"${term}"`;
          selectParts.push(`${projectionExpr} AS ${colName}`);
          columnMap.set(term, term);
        }
        continue;
      }

      const colName = `"${term}"`;
      selectParts.push(`${getColumnExpression(binding)} AS ${colName}`);
      columnMap.set(term, term);
      continue;
    }

    const colName = `"${String(term)}"`;
    selectParts.push(`${formatValue(term, ctx)} AS ${colName}`);
    columnMap.set(String(term), String(term));
  }

  let groupByClause = "";
  if (hasAggregates) {
    const groupByParts: string[] = [];
    for (const term of find) {
      if (isVariable(term) && !aggregateTargets.has(term)) {
        const binding = ctx.bindings.get(term);
        if (binding) {
          groupByParts.push(getColumnExpression(binding));
        }
      }
    }
    if (groupByParts.length > 0) {
      groupByClause = `GROUP BY ${groupByParts.join(", ")}`;
    }
  }

  if (selectParts.length === 0) {
    selectParts.push(`1 AS "_dummy"`);
  }

  return { columnMap, selectParts, groupByClause, hasAggregates, aggregateOps };
};

// =============================================================================
// Main Compilation
// =============================================================================

/**
 * Compile a Datalog query to SQL
 *
 * @param query - The Datalog query to compile
 * @param dialect - SQL dialect to use (defaults to SQLite)
 * @param includeMetrics - Whether to include compilation metrics (for debugging)
 */
export const compile = (
  query: DatalogQuery,
  dialect: SqlDialect = SqliteDialect,
  includeMetrics = false,
): CompiledQuery => {
  const startTime = includeMetrics ? performance.now() : 0;
  const ctx = createContext(dialect);
  const { find, where, aggregate, having, orderBy, limit, offset, optionalProjection } = query;
  const { patterns, predicates, notClauses, orClauses, linkClauses } = classifyClauses(where, {
    allowRuleApplications: false,
  });

  // Must have at least one pattern or link clause
  if (patterns.length === 0 && linkClauses.length === 0) {
    throw new Error("Datalog query must have at least one pattern clause or link clause");
  }

  // Compile patterns first (establishes bindings)
  patterns.forEach((pattern, idx) => {
    const alias = compilePattern(pattern, ctx, idx === 0);
    ctx.patternAliases.set(idx, alias);
  });

  // Compile link clauses
  for (const linkClause of linkClauses) {
    compileLinkClause(linkClause, ctx);
  }

  // Compile predicates (uses bindings)
  for (const predicate of predicates) {
    compilePredicate(predicate, ctx);
  }

  // Compile NOT clauses
  for (const notClause of notClauses) {
    compileNot(notClause, ctx);
  }

  // Compile OR clauses
  for (const orClause of orClauses) {
    compileOr(orClause, ctx);
  }

  const { columnMap, selectParts, groupByClause, hasAggregates, aggregateOps } =
    buildSelectAndGroupBy(find, aggregate, optionalProjection, ctx);

  // Build HAVING, ORDER BY, LIMIT clauses
  const havingClause = buildHavingClause(having, ctx);
  const orderByClause = buildOrderByClause(orderBy, ctx);
  const limitClause = buildLimitClause(limit, offset, dialect);

  // Build final SQL
  const fromTable = `triples t0`;
  const joinClause = ctx.joins.length > 0 ? ctx.joins.join("\n") : "";
  const whereClause = ctx.conditions.length > 0 ? `WHERE ${ctx.conditions.join(" AND ")}` : "";

  const sql = [
    `SELECT DISTINCT`,
    `  ${selectParts.join(",\n  ")}`,
    `FROM ${fromTable}`,
    joinClause,
    whereClause,
    groupByClause,
    havingClause,
    orderByClause,
    limitClause,
  ]
    .filter(Boolean)
    .join("\n");

  const result: CompiledQuery = {
    sql,
    params: [...ctx.collector.params],
    columnMap,
  };

  if (includeMetrics) {
    result.metrics = {
      joinCount: ctx.joins.length,
      whereConditionCount: ctx.conditions.length,
      subqueryCount: notClauses.length,
      cteCount: 0, // Will be set in compileWithRules
      sqlLength: sql.length,
      paramCount: ctx.collector.params.length,

      patternCount: patterns.length,
      predicateCount: predicates.length,
      notClauseCount: notClauses.length,
      orClauseCount: orClauses.length,
      linkClauseCount: linkClauses.length,

      hasAggregation: Boolean(hasAggregates),
      isRecursive: false, // Will be set in compileWithRules
      aggregateOps,

      compilationTimeMs: performance.now() - startTime,
    };
  }

  return result;
};

/**
 * Compile and return just the SQL string (convenience function)
 */
export const compileToSql = (query: DatalogQuery, dialect: SqlDialect = SqliteDialect): string => {
  return compile(query, dialect).sql;
};

// =============================================================================
// Recursive Query Compilation
// =============================================================================

/**
 * Group rules by name for generating CTEs
 * Multiple rules with the same name are combined with UNION (like OR semantics)
 */
const groupRulesByName = (rules: readonly Rule[]): Map<string, Rule[]> => {
  const grouped = new Map<string, Rule[]>();
  for (const rule of rules) {
    const existing = grouped.get(rule.name) ?? [];
    existing.push(rule);
    grouped.set(rule.name, existing);
  }
  return grouped;
};

/**
 * Compile a single rule definition to SQL for a CTE
 * Returns SQL that selects (arg1, arg2) based on the rule body
 */
const compileRuleDefinition = (rule: Rule): string => {
  const { body } = rule;

  if (body.length === 0) {
    throw new Error(`Rule "${rule.name}" has no body clauses`);
  }

  // Find the variables that map to arg1 and arg2
  // We infer from the first pattern's entity/value positions
  // Convention: arg1 = first entity, arg2 = last value in chain
  let arg1Var: string | null = null;
  let arg2Var: string | null = null;

  // Scan body to identify arg1 and arg2 variables
  // For patterns like [?x, :parent, ?y], ?x is arg1, ?y is arg2
  for (const clause of body) {
    if (!isRuleApplication(clause)) {
      const [entity, , value] = clause as PatternClause;
      if (isVariable(entity) && !arg1Var) {
        arg1Var = entity;
      }
      if (isVariable(value)) {
        arg2Var = value;
      }
    }
  }

  if (!arg1Var || !arg2Var) {
    throw new Error(`Rule "${rule.name}" must have variables for both arg1 and arg2`);
  }

  // Build the SQL query for this rule definition
  const paramMap = new Map<string, string>();
  const aliasCounter = { value: 0 };
  const fromParts: string[] = [];
  const allConditions: string[] = [];
  const allJoins: string[] = [];

  // Process each clause in the body
  for (let i = 0; i < body.length; i++) {
    const clause = body[i]!;
    const alias = `t${i}`;

    if (isRuleApplication(clause)) {
      // Handle recursive rule application
      const [ruleName, clauseArg1, clauseArg2] = clause;

      // Add JOIN to the recursive CTE
      if (fromParts.length === 0) {
        fromParts.push(`${ruleName} r0`);

        // Map the rule application arguments
        if (isVariable(clauseArg1)) {
          paramMap.set(clauseArg1, "r0.arg1");
        }
        if (isVariable(clauseArg2)) {
          paramMap.set(clauseArg2, "r0.arg2");
        }
      } else {
        // Join condition - link to previously bound variables
        const joinConditions: string[] = [];

        if (isVariable(clauseArg1)) {
          const boundCol = paramMap.get(clauseArg1);
          if (boundCol) {
            joinConditions.push(`r${aliasCounter.value}.arg1 = ${boundCol}`);
          }
          paramMap.set(clauseArg1, `r${aliasCounter.value}.arg1`);
        } else {
          joinConditions.push(`r${aliasCounter.value}.arg1 = ${formatValueForRules(clauseArg1)}`);
        }

        if (isVariable(clauseArg2)) {
          const boundCol = paramMap.get(clauseArg2);
          if (boundCol) {
            joinConditions.push(`r${aliasCounter.value}.arg2 = ${boundCol}`);
          }
          paramMap.set(clauseArg2, `r${aliasCounter.value}.arg2`);
        } else {
          joinConditions.push(`r${aliasCounter.value}.arg2 = ${formatValueForRules(clauseArg2)}`);
        }

        allJoins.push(`JOIN ${ruleName} r${aliasCounter.value} ON ${joinConditions.join(" AND ")}`);
        aliasCounter.value++;
      }
    } else {
      // Pattern clause
      const [entity, attribute, value] = clause as PatternClause;

      if (fromParts.length === 0) {
        fromParts.push(`triples ${alias}`);
        allConditions.push(`${alias}.retracted_at IS NULL`);

        // Handle entity
        if (isVariable(entity)) {
          paramMap.set(entity, `${alias}.entity_id`);
        } else {
          allConditions.push(`${alias}.entity_id = ${formatValueForRules(entity)}`);
        }

        // Handle attribute
        if (isVariable(attribute)) {
          paramMap.set(attribute, `${alias}.attribute`);
        } else {
          allConditions.push(`${alias}.attribute = ${formatValueForRules(attribute)}`);
        }

        // Handle value
        if (isVariable(value)) {
          paramMap.set(value, `${alias}.value_string`);
        } else {
          const valueCol = getValueColumn(value);
          allConditions.push(`${alias}.${valueCol} = ${formatValueForRules(value)}`);
          allConditions.push(`${alias}.value_type = '${inferValueType(value)}'`);
        }
      } else {
        // JOIN to the triples table
        const joinConditions: string[] = [`${alias}.retracted_at IS NULL`];

        // Handle entity - check if it should join to a previous binding
        if (isVariable(entity)) {
          const boundCol = paramMap.get(entity);
          if (boundCol) {
            joinConditions.push(`${alias}.entity_id = ${boundCol}`);
          }
          paramMap.set(entity, `${alias}.entity_id`);
        } else {
          joinConditions.push(`${alias}.entity_id = ${formatValueForRules(entity)}`);
        }

        // Handle attribute
        if (isVariable(attribute)) {
          const boundCol = paramMap.get(attribute);
          if (boundCol) {
            joinConditions.push(`${alias}.attribute = ${boundCol}`);
          }
          paramMap.set(attribute, `${alias}.attribute`);
        } else {
          joinConditions.push(`${alias}.attribute = ${formatValueForRules(attribute)}`);
        }

        // Handle value
        if (isVariable(value)) {
          const boundCol = paramMap.get(value);
          if (boundCol) {
            joinConditions.push(`${alias}.value_string = ${boundCol}`);
          }
          paramMap.set(value, `${alias}.value_string`);
        } else {
          const valueCol = getValueColumn(value);
          joinConditions.push(`${alias}.${valueCol} = ${formatValueForRules(value)}`);
          joinConditions.push(`${alias}.value_type = '${inferValueType(value)}'`);
        }

        allJoins.push(`JOIN triples ${alias} ON ${joinConditions.join(" AND ")}`);
      }
    }
  }

  // Build SELECT with arg1 and arg2
  const arg1Col = paramMap.get(arg1Var) ?? "NULL";
  const arg2Col = paramMap.get(arg2Var) ?? "NULL";

  const selectClause = `SELECT DISTINCT ${arg1Col} AS arg1, ${arg2Col} AS arg2`;
  const fromClause = `FROM ${fromParts[0]}`;
  const joinClause = allJoins.length > 0 ? allJoins.join("\n") : "";
  const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";

  return [selectClause, fromClause, joinClause, whereClause].filter(Boolean).join("\n");
};

/**
 * Compile a recursive CTE for a rule
 * Combines base case and recursive case with UNION
 *
 * For ancestor rules like:
 *   ancestor(X, Y) :- X :parent Y.          (base case)
 *   ancestor(X, Y) :- X :parent Z, ancestor(Z, Y).  (recursive case)
 *
 * The CTE structure is:
 *   WITH RECURSIVE ancestor(arg1, arg2, depth) AS (
 *     -- Base: direct parent relationship
 *     SELECT entity_id, value_string, 0 FROM triples WHERE attribute = ':parent'
 *     UNION ALL
 *     -- Recursive: extend through another parent edge
 *     SELECT t.entity_id, a.arg2, a.depth + 1
 *     FROM triples t
 *     JOIN ancestor a ON t.value_string = a.arg1
 *     WHERE t.attribute = ':parent' AND a.depth < maxDepth
 *   )
 */
const compileRecursiveCTE = (ruleName: string, rules: Rule[]): string => {
  // Separate base cases (no recursive calls) from recursive cases
  const baseCases: Rule[] = [];
  const recursiveCases: Rule[] = [];

  for (const rule of rules) {
    const hasRecursion = rule.body.some(
      (clause) => isRuleApplication(clause) && clause[0] === ruleName,
    );
    if (hasRecursion) {
      recursiveCases.push(rule);
    } else {
      baseCases.push(rule);
    }
  }

  if (baseCases.length === 0) {
    throw new Error(`Rule "${ruleName}" has no base case (non-recursive definition)`);
  }

  // Get max depth from any rule (default 100)
  const maxDepth = Math.max(...rules.map((r) => r.maxDepth ?? 100));

  // Build base case SQL (UNION ALL of all base cases)
  const baseSqls = baseCases.map((rule) => compileRuleDefinition(rule));
  const baseUnion = baseSqls.join("\nUNION ALL\n");

  // Build recursive case SQL
  if (recursiveCases.length === 0) {
    // Non-recursive rule - just use base case
    return `${ruleName} AS (\n${baseUnion}\n)`;
  }

  // For recursive rules, we need to build a proper SQLite-compatible recursive CTE
  // SQLite requires the recursive reference to be a simple join, not in a subquery

  // Compile the recursive member directly (pattern + join to CTE)
  // The typical recursive rule is: [pattern, rule_application]
  // e.g., ancestor(X,Y) :- X :parent Z, ancestor(Z,Y)
  // This means: find X's parent Z, then find Z's ancestors Y
  const recursiveMembers: string[] = [];

  for (const rule of recursiveCases) {
    // Find the pattern clause and recursive application
    const patternClauses = rule.body.filter((c) => !isRuleApplication(c)) as PatternClause[];
    const ruleApps = rule.body.filter((c) => isRuleApplication(c)) as RuleApplication[];

    if (patternClauses.length === 0 || ruleApps.length === 0) {
      throw new Error(`Recursive rule "${ruleName}" must have both pattern and recursive call`);
    }

    // For now, handle the simple case: one pattern + one recursive call
    const pattern = patternClauses[0]!;
    const [, ruleArg1] = ruleApps[0]!;
    const [entity, attribute, value] = pattern;

    // Build the recursive SELECT
    // SELECT t.entity_id AS arg1, r.arg2 AS arg2, r.depth + 1 AS depth
    // FROM triples t JOIN ruleName r ON join_condition
    // WHERE t.attribute = ':attr' AND t.retracted_at IS NULL AND r.depth < maxDepth

    const conditions: string[] = [`t.retracted_at IS NULL`, `r.depth < ${maxDepth}`];

    // Handle attribute
    if (!isVariable(attribute)) {
      conditions.push(`t.attribute = ${formatValueForRules(attribute)}`);
    }

    // Handle value - this is usually the link to the recursive call
    // e.g., in [?x, :parent, ?z] followed by [ancestor, ?z, ?y]
    // value (?z) links to the rule application's first arg

    // Determine the join condition based on how variables are linked
    let joinCondition = "1=1";
    if (isVariable(value) && isVariable(ruleArg1) && value === ruleArg1) {
      // The pattern's value links to the rule's arg1
      // SELECT entity_id, r.arg2 FROM triples t JOIN rule r ON t.value_string = r.arg1
      joinCondition = "t.value_string = r.arg1";
    } else if (isVariable(entity) && isVariable(ruleArg1) && entity === ruleArg1) {
      // The pattern's entity links to the rule's arg1
      joinCondition = "t.entity_id = r.arg1";
    }

    // Determine what to select for arg1 and arg2
    let selectArg1 = "t.entity_id";
    let selectArg2 = "r.arg2";

    // If the pattern entity is the first variable and value is linked to rule arg1
    // then entity -> arg1, rule.arg2 -> arg2
    // This gives us: for each X, find its parent Z, get ancestor of Z which is Y
    // Result: (X, Y) = (entity_id, r.arg2)

    const recursiveSql = `SELECT ${selectArg1} AS arg1, ${selectArg2} AS arg2, r.depth + 1 AS depth
FROM triples t
JOIN ${ruleName} r ON ${joinCondition}
WHERE ${conditions.join(" AND ")}`;

    recursiveMembers.push(recursiveSql);
  }

  // SQLite recursive CTE format
  return `${ruleName}(arg1, arg2, depth) AS (
  -- Base case
  SELECT arg1, arg2, 0 AS depth FROM (
    ${baseUnion.split("\n").join("\n    ")}
  )
  UNION ALL
  -- Recursive case
  ${recursiveMembers.join("\n  UNION ALL\n  ")}
)`;
};

/**
 * Compile a rule application in the main query's WHERE clause
 */
const compileRuleApplicationInWhere = (ruleApp: RuleApplication, ctx: CompilerContext): void => {
  const [ruleName, arg1, arg2] = ruleApp;
  const ruleAlias = `${ruleName}_ref`;

  // Build join conditions
  const joinConditions: string[] = [];

  // Handle arg1
  if (isVariable(arg1)) {
    const binding = ctx.bindings.get(arg1);
    if (binding) {
      const boundCol = resolveBinding(binding, { valueMode: "string" });
      joinConditions.push(`${ruleAlias}.arg1 = ${boundCol}`);
    } else {
      // New variable - we'll bind it from the rule result
      ctx.bindings.set(arg1, ruleBinding(ruleAlias, "arg1"));
    }
  } else {
    joinConditions.push(`${ruleAlias}.arg1 = ${formatValue(arg1, ctx)}`);
  }

  // Handle arg2
  if (isVariable(arg2)) {
    const binding = ctx.bindings.get(arg2);
    if (binding) {
      const boundCol = resolveBinding(binding, { valueMode: "string" });
      joinConditions.push(`${ruleAlias}.arg2 = ${boundCol}`);
    } else {
      // New variable - bind it from rule result
      ctx.bindings.set(arg2, ruleBinding(ruleAlias, "arg2"));
    }
  } else {
    joinConditions.push(`${ruleAlias}.arg2 = ${formatValue(arg2, ctx)}`);
  }

  // Add the JOIN
  const joinCondition = joinConditions.length > 0 ? joinConditions.join(" AND ") : "1=1";
  ctx.joins.push(`JOIN ${ruleName} ${ruleAlias} ON ${joinCondition}`);
};

/**
 * Compile a Datalog query with recursive rules to SQL using CTEs
 */
export const compileWithRules = (
  query: DatalogQuery,
  dialect: SqlDialect = SqliteDialect,
  includeMetrics = false,
): CompiledQuery => {
  const { rules } = query;

  // If no rules, use the standard compiler
  if (!rules || rules.length === 0) {
    return compile(query as DatalogQuery, dialect, includeMetrics);
  }

  const startTime = includeMetrics ? performance.now() : 0;

  const ctx = createContext(dialect);
  const { find, where, aggregate, having, orderBy, limit, offset } = query as DatalogQuery & {
    having?: readonly HavingClause[];
    orderBy?: readonly OrderBySpec[];
    limit?: number;
    offset?: number;
  };

  // Group rules by name
  const groupedRules = groupRulesByName(rules);

  // Generate CTEs for each rule
  const ctes: string[] = [];
  for (const [ruleName, ruleList] of groupedRules) {
    ctes.push(compileRecursiveCTE(ruleName, ruleList));
  }

  const { patterns, predicates, notClauses, orClauses, linkClauses, ruleApplications } =
    classifyClauses(where, {
      allowRuleApplications: true,
    });

  // Must have at least one pattern, link clause, or rule application
  if (patterns.length === 0 && linkClauses.length === 0 && ruleApplications.length === 0) {
    throw new Error(
      "Datalog query must have at least one pattern clause, link clause, or rule application",
    );
  }

  // Compile patterns first (establishes bindings)
  patterns.forEach((pattern, idx) => {
    const alias = compilePattern(pattern, ctx, idx === 0);
    ctx.patternAliases.set(idx, alias);
  });

  // Compile link clauses
  for (const linkClause of linkClauses) {
    compileLinkClause(linkClause, ctx);
  }

  // Compile rule applications
  for (const ruleApp of ruleApplications) {
    compileRuleApplicationInWhere(ruleApp, ctx);
  }

  // Compile predicates (uses bindings)
  for (const predicate of predicates) {
    compilePredicate(predicate, ctx);
  }

  // Compile NOT clauses
  for (const notClause of notClauses) {
    compileNot(notClause, ctx);
  }

  // Compile OR clauses
  for (const orClause of orClauses) {
    compileOr(orClause, ctx);
  }

  const { columnMap, selectParts, groupByClause, hasAggregates, aggregateOps } =
    buildSelectAndGroupBy(find, aggregate, query.optionalProjection, ctx);

  // Build HAVING, ORDER BY, LIMIT clauses
  const havingClause = buildHavingClause(having, ctx);
  const orderByClause = buildOrderByClause(orderBy, ctx);
  const limitClause = buildLimitClause(limit, offset, dialect);

  // Build final SQL with CTEs
  const cteClause = ctes.length > 0 ? `WITH RECURSIVE\n${ctes.join(",\n")}\n` : "";

  // Handle case where only rule applications exist (no patterns)
  let fromTable: string;
  if (patterns.length === 0 && ruleApplications.length > 0) {
    // First rule application becomes the FROM
    const firstRule = ruleApplications[0]!;
    const [ruleName] = firstRule;
    fromTable = `${ruleName} ${ruleName}_ref`;

    // Remove the first rule's JOIN since it's now in FROM
    // The JOIN conditions (including constant arguments) are already embedded in the JOIN string
    // and params were already added during compileRuleApplicationInWhere
    if (ctx.joins.length > 0 && ctx.joins[0]?.includes(`${ruleName}_ref`)) {
      // Extract the ON clause from the JOIN and add it to conditions
      const joinStr = ctx.joins.shift()!;
      const onMatch = joinStr.match(/ON (.+)$/);
      if (onMatch?.[1] && onMatch[1] !== "1=1") {
        ctx.conditions.push(onMatch[1]);
      }
    }
  } else {
    fromTable = `triples t0`;
  }

  const joinClause = ctx.joins.length > 0 ? ctx.joins.join("\n") : "";
  const whereClause = ctx.conditions.length > 0 ? `WHERE ${ctx.conditions.join(" AND ")}` : "";

  const sql = [
    cteClause + `SELECT DISTINCT`,
    `  ${selectParts.join(",\n  ")}`,
    `FROM ${fromTable}`,
    joinClause,
    whereClause,
    groupByClause,
    havingClause,
    orderByClause,
    limitClause,
  ]
    .filter(Boolean)
    .join("\n");

  const result: CompiledQuery = {
    sql,
    params: [...ctx.collector.params],
    columnMap,
  };

  if (includeMetrics) {
    result.metrics = {
      joinCount: ctx.joins.length,
      whereConditionCount: ctx.conditions.length,
      subqueryCount: notClauses.length,
      cteCount: ctes.length,
      sqlLength: sql.length,
      paramCount: ctx.collector.params.length,

      patternCount: patterns.length,
      predicateCount: predicates.length,
      notClauseCount: notClauses.length,
      orClauseCount: orClauses.length,
      linkClauseCount: linkClauses.length,

      hasAggregation: Boolean(hasAggregates),
      isRecursive: true, // This function is only called for recursive queries
      aggregateOps,

      compilationTimeMs: performance.now() - startTime,
    };
  }

  return result;
};

/**
 * Compile a query with rules and return just the SQL string
 */
export const compileWithRulesToSql = (
  query: DatalogQuery,
  dialect: SqlDialect = SqliteDialect,
): string => {
  return compileWithRules(query, dialect).sql;
};

/** @internal Exported for testing only */
export {
  tripleBinding,
  ruleBinding,
  resolveBinding,
  isValueLikeBinding,
  parseClause,
  classifyClauses,
};
export type { VariableBinding, BindingValueMode, ClassifiedClauses };
