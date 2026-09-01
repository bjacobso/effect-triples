/**
 * KV Datalog query executor.
 *
 * Executes DatalogQuery objects against a KvTripleStore, producing
 * arrays of Context (variable binding) tuples as results.
 *
 * Supports the standard clause types:
 * - Pattern: index scan + binding (via hexastore)
 * - Predicate: comparison filter
 * - Not: anti-semi-join (negation)
 * - Or: union of alternatives
 * - RuleApplication: recursive rules via fixpoint evaluation
 *
 * Plus aggregation (5 ops), HAVING, ORDER BY, LIMIT/OFFSET,
 * and wrapper queries with cursor-based keyset pagination.
 */

import { Effect, Result, Encoding, Stream } from "effect";
import type { KvTripleStore } from "../hexastore/KvTripleStore.js";
import type { TripleValue } from "../../Value.js";
import {
  type Context,
  type Constant,
  type Term,
  type Clause,
  type PatternClause,
  type PredicateClause,
  type NotClause,
  type OrAlternative,
  type OrClause,
  type RuleApplication,
  type Rule,
  type DatalogQuery,
  type AggregateSpec,
  type HavingClause,
  type OrderBySpec,
  type WrappedQuery,
  type WrapperFilter,
  isVariable,
  isPredicateClause,
  isNotClause,
  isOrClause,
  isRuleApplication,
  isPatternClause,
  emptyContext,
} from "./types.js";
import { executePattern } from "./pattern.js";
import { evaluatePredicate } from "./predicate.js";
import { normalizeOrAlternatives } from "../../datalog/schema.js";

// ─── Clause execution ──────────────────────────────────────────────────────

/**
 * Check whether a sequence of not-inner clauses matches for one context.
 * Pattern clauses may bind local variables for later inner clauses, but those
 * bindings are discarded by the caller.
 */
const innerClausesMatchContext = (
  store: KvTripleStore,
  clauses: readonly (PatternClause | PredicateClause)[],
  context: Context,
  asOf?: number,
): Effect.Effect<boolean> => {
  return Effect.gen(function* () {
    let current: Context[] = [context];

    for (const clause of clauses) {
      if (isPredicateClause(clause as Clause)) {
        current = current.filter((ctx) => evaluatePredicate(clause as PredicateClause, ctx));
      } else {
        current = yield* executePattern(store, clause as PatternClause, current, asOf);
      }

      if (current.length === 0) return false;
    }

    return true;
  });
};

const patternAlternativeMatchesContext = (
  store: KvTripleStore,
  pattern: PatternClause,
  context: Context,
  asOf?: number,
): Effect.Effect<boolean> =>
  Effect.map(executePattern(store, pattern, [context], asOf), (matches) => matches.length > 0);

const notClauseInnerClauses = (clause: NotClause): (PatternClause | PredicateClause)[] =>
  clause.slice(1) as (PatternClause | PredicateClause)[];

const notClauseMatchesContext = (
  store: KvTripleStore,
  clause: NotClause,
  context: Context,
  asOf?: number,
): Effect.Effect<boolean> =>
  innerClausesMatchContext(store, notClauseInnerClauses(clause), context, asOf);

const orAlternativeMatchesContext = (
  store: KvTripleStore,
  alternative: OrAlternative,
  context: Context,
  asOf?: number,
): Effect.Effect<boolean> => {
  if (isPredicateClause(alternative as Clause)) {
    return Effect.succeed(evaluatePredicate(alternative as PredicateClause, context));
  }

  if (isNotClause(alternative as Clause)) {
    return Effect.map(
      notClauseMatchesContext(store, alternative as NotClause, context, asOf),
      (matches) => !matches,
    );
  }

  return patternAlternativeMatchesContext(store, alternative as PatternClause, context, asOf);
};

/**
 * Execute a NOT clause (anti-semi-join).
 *
 * ["not", clause1, clause2, ...] — filter out contexts where all inner clauses
 * match together. Inner variables are local and do not leak outward.
 */
const executeNot = (
  store: KvTripleStore,
  clause: NotClause,
  contexts: readonly Context[],
  asOf?: number,
): Effect.Effect<Context[]> => {
  return Effect.gen(function* () {
    const results: Context[] = [];

    for (const ctx of contexts) {
      const hasMatch = yield* notClauseMatchesContext(store, clause, ctx, asOf);
      if (!hasMatch) results.push(ctx);
    }

    return results;
  });
};

/**
 * Execute an OR clause as a filter.
 *
 * ["or", [alternative1, alternative2, ...]] — keep each incoming context if
 * any alternative matches. Alternative-local variables do not leak outward.
 */
const executeOr = (
  store: KvTripleStore,
  clause: OrClause,
  contexts: readonly Context[],
  asOf?: number,
): Effect.Effect<Context[]> => {
  const alternatives = normalizeOrAlternatives(clause) as OrAlternative[];

  return Effect.gen(function* () {
    const results: Context[] = [];

    for (const ctx of contexts) {
      for (const alt of alternatives) {
        if (yield* orAlternativeMatchesContext(store, alt, ctx, asOf)) {
          results.push(ctx);
          break;
        }
      }
    }

    return results;
  });
};

// ─── Rule execution (naive fixpoint evaluation) ────────────────────────────

/**
 * Execute recursive rules by repeatedly evaluating rule bodies against all
 * pairs discovered so far. A seen set terminates at the fixpoint. This is
 * intentionally the simple, correct algorithm; it is not semi-naive.
 */
interface RulePair {
  readonly arg1: Constant | null;
  readonly arg2: Constant | null;
}

const ruleHeadVariables = (rule: Rule): readonly [string, string] | null => {
  let arg1: string | undefined;
  let arg2: string | undefined;
  for (const clause of rule.body) {
    if (isRuleApplication(clause)) {
      if (!arg1 && isVariable(clause[1])) arg1 = clause[1];
      if (isVariable(clause[2])) arg2 = clause[2];
    } else {
      if (!arg1 && isVariable(clause[0])) arg1 = clause[0];
      if (isVariable(clause[2])) arg2 = clause[2];
    }
  }
  return arg1 && arg2 ? [arg1, arg2] : null;
};

const normalizedRuleConstant = (value: Constant | null): Constant | null =>
  typeof value === "object" && value !== null && "type" in value ? value.value : value;

const bindRuleTerm = (term: Term, value: Constant | null, context: Context): Context | null => {
  const normalized = normalizedRuleConstant(value);
  if (isVariable(term)) {
    return term in context
      ? normalizedRuleConstant(context[term]!) === normalized
        ? context
        : null
      : { ...context, [term]: normalized };
  }
  return normalizedRuleConstant(term) === normalized ? context : null;
};

const applyRulePairs = (
  contexts: readonly Context[],
  application: RuleApplication,
  pairs: readonly RulePair[],
): Context[] => {
  const [, arg1, arg2] = application;
  const results: Context[] = [];
  for (const context of contexts) {
    for (const pair of pairs) {
      const withArg1 = bindRuleTerm(arg1, pair.arg1, context);
      if (withArg1 === null) continue;
      const withArg2 = bindRuleTerm(arg2, pair.arg2, withArg1);
      if (withArg2 !== null) results.push(withArg2);
    }
  }
  return results;
};

const deriveRulePairs = (
  store: KvTripleStore,
  rules: readonly Rule[],
  ruleName: string,
  asOf?: number,
): Effect.Effect<RulePair[]> =>
  Effect.gen(function* () {
    const definitions = rules.filter((rule) => rule.name === ruleName);
    if (definitions.length === 0) return [];

    const maxDepth = Math.max(...definitions.map((rule) => rule.maxDepth ?? 50));
    const pairs: RulePair[] = [];
    const seen = new Set<string>();

    // Iteration zero derives base facts. Each later iteration may extend them
    // through same-named recursive applications until the relation stabilizes.
    for (let depth = 0; depth <= maxDepth; depth++) {
      const discovered: RulePair[] = [];
      for (const definition of definitions) {
        const head = ruleHeadVariables(definition);
        if (head === null) continue;
        let current: Context[] = [emptyContext];
        for (const clause of definition.body) {
          current = isRuleApplication(clause)
            ? clause[0] === ruleName
              ? applyRulePairs(current, clause, pairs)
              : []
            : yield* executePattern(store, clause as PatternClause, current, asOf);
          if (current.length === 0) break;
        }
        for (const context of current) {
          const pair = { arg1: context[head[0]]!, arg2: context[head[1]]! };
          const key = JSON.stringify([pair.arg1, pair.arg2]);
          if (!seen.has(key)) {
            seen.add(key);
            discovered.push(pair);
          }
        }
      }
      if (discovered.length === 0) break;
      pairs.push(...discovered);
    }
    return pairs;
  });

const executeRules = (
  store: KvTripleStore,
  rules: readonly Rule[],
  contexts: readonly Context[],
  ruleApplication: RuleApplication,
  asOf?: number,
): Effect.Effect<Context[]> =>
  deriveRulePairs(store, rules, ruleApplication[0], asOf).pipe(
    Effect.map((pairs) => applyRulePairs(contexts, ruleApplication, pairs)),
  );

// ─── Main clause dispatcher ────────────────────────────────────────────────

/**
 * Execute a single clause against the current set of contexts.
 */
const executeClause = (
  store: KvTripleStore,
  clause: Clause,
  contexts: readonly Context[],
  rules: readonly Rule[],
  asOf?: number,
): Effect.Effect<Context[]> => {
  if (isPredicateClause(clause)) {
    return Effect.succeed(
      contexts.filter((ctx) => evaluatePredicate(clause as PredicateClause, ctx)),
    );
  }

  if (isNotClause(clause)) {
    return executeNot(store, clause as NotClause, contexts, asOf);
  }

  if (isOrClause(clause)) {
    return executeOr(store, clause as OrClause, contexts, asOf);
  }

  if (isRuleApplication(clause)) {
    return executeRules(store, rules, contexts, clause as RuleApplication, asOf);
  }

  if (isPatternClause(clause)) {
    return executePattern(store, clause as PatternClause, contexts, asOf);
  }

  // Unknown clause type — pass through
  return Effect.succeed([...contexts]);
};

// ─── Where clause processing ───────────────────────────────────────────────

/**
 * Process all WHERE clauses sequentially (index nested loop join).
 *
 * Starting from a single empty context, progressively execute each clause.
 * Shared variables between clauses create implicit joins.
 */
const executeWhere = (
  store: KvTripleStore,
  clauses: readonly Clause[],
  rules: readonly Rule[],
  asOf?: number,
): Effect.Effect<Context[]> => {
  return Effect.gen(function* () {
    let contexts: Context[] = [emptyContext];

    for (const clause of clauses) {
      contexts = yield* executeClause(store, clause, contexts, rules, asOf);
      if (contexts.length === 0) break;
    }

    return contexts;
  });
};

// ─── Result extraction (find/actualize) ────────────────────────────────────

/**
 * Extract the find variables from contexts, producing the final result rows.
 * Only variables listed in `find` are included in each result row.
 * Deduplicates results.
 */
const actualize = (contexts: readonly Context[], find: readonly Term[]): Context[] => {
  const results: Context[] = [];
  const seen = new Set<string>();

  for (const ctx of contexts) {
    const row: Record<string, Constant | null> = {};
    for (const term of find) {
      if (isVariable(term)) {
        if (term in ctx) {
          row[term] = ctx[term]!;
        } else {
          row[term] = null;
        }
      } else {
        row[String(term)] = term as Constant;
      }
    }

    const key = JSON.stringify(row);
    if (!seen.has(key)) {
      seen.add(key);
      results.push(row);
    }
  }

  return results;
};

const tripleValueToResultValue = (value: TripleValue): Constant => {
  switch (value.type) {
    case "string":
    case "ref":
    case "blob":
      return value.value;
    case "number":
    case "datetime":
      return value.value;
    case "boolean":
      return value.value;
    case "json":
      return JSON.stringify(value.value);
  }
};

const hydrateOptionalProjection = (
  store: KvTripleStore,
  query: DatalogQuery,
  rows: readonly Context[],
  asOf?: number,
): Effect.Effect<Context[]> => {
  const projection = query.optionalProjection;
  if (!projection || projection.fields.length === 0) {
    return Effect.succeed([...rows]);
  }

  return Effect.gen(function* () {
    const entityCache = new Map<string, Map<string, Constant>>();

    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const hydrated: Record<string, Constant | null> = { ...row };
        const entityId = row[projection.rowBinding];

        if (typeof entityId !== "string") {
          for (const field of projection.fields) {
            if (!(field.variable in hydrated)) {
              hydrated[field.variable] = null;
            }
          }
          return hydrated as Context;
        }

        let entityFields = entityCache.get(entityId);
        if (!entityFields) {
          entityFields = new Map<string, Constant>();
          const datoms = yield* asOf === undefined
            ? store.getEntity(entityId).pipe(Stream.runCollect)
            : store.scanCollectAsOfAsync({ entity: entityId }, asOf);
          for (const datom of datoms) {
            if (!entityFields.has(datom.attribute)) {
              entityFields.set(datom.attribute, tripleValueToResultValue(datom.value));
            }
          }
          entityCache.set(entityId, entityFields);
        }

        for (const field of projection.fields) {
          if (hydrated[field.variable] !== null && hydrated[field.variable] !== undefined) continue;
          hydrated[field.variable] = entityFields.get(field.attribute) ?? null;
        }

        return hydrated as Context;
      }),
    );
  });
};

// ─── Aggregation ───────────────────────────────────────────────────────────

/**
 * Apply aggregation to result rows.
 *
 * Groups by non-aggregated find variables, then computes each aggregate.
 * Supports: count, sum, avg, min, max.
 */
const aggregate = (
  results: readonly Context[],
  find: readonly Term[],
  aggregates: readonly AggregateSpec[],
): Context[] => {
  // Determine group-by variables: find variables that are NOT aggregate input or output variables
  const aggregateInputVars = new Set(aggregates.map((a) => a[1]));
  const aggregateOutputVars = new Set(aggregates.map((a) => a[2]));
  const groupByVars = find.filter(
    (t) => isVariable(t) && !aggregateOutputVars.has(t) && !aggregateInputVars.has(t),
  ) as string[];

  // Group results
  const groups = new Map<string, Context[]>();
  for (const row of results) {
    const groupKey = JSON.stringify(groupByVars.map((v) => row[v]));
    const group = groups.get(groupKey) ?? [];
    group.push(row);
    groups.set(groupKey, group);
  }

  // Compute aggregates per group
  const aggregatedResults: Context[] = [];

  for (const group of groups.values()) {
    const representative = group[0]!;
    const row: Record<string, Constant> = {};

    // Copy group-by values
    for (const v of groupByVars) {
      if (v in representative) {
        row[v] = representative[v]!;
      }
    }

    // Compute each aggregate
    for (const [op, inputVar, outputVar] of aggregates) {
      const values = group
        .map((ctx) => ctx[inputVar])
        .filter((v): v is Constant => v !== undefined);

      row[outputVar] = computeAggregate(op, values);
    }

    aggregatedResults.push(row);
  }

  return aggregatedResults;
};

const computeAggregate = (op: string, values: readonly Constant[]): Constant => {
  switch (op) {
    case "count":
      return values.length;

    case "sum": {
      let sum = 0;
      for (const v of values) {
        if (typeof v === "number") sum += v;
      }
      return sum;
    }

    case "avg": {
      let sum = 0;
      let count = 0;
      for (const v of values) {
        if (typeof v === "number") {
          sum += v;
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    }

    case "min": {
      let min: number = Infinity;
      for (const v of values) {
        if (typeof v === "number" && v < min) min = v;
      }
      return min === Infinity ? 0 : min;
    }

    case "max": {
      let max: number = -Infinity;
      for (const v of values) {
        if (typeof v === "number" && v > max) max = v;
      }
      return max === -Infinity ? 0 : max;
    }

    default:
      return 0;
  }
};

// ─── HAVING ────────────────────────────────────────────────────────────────

/**
 * Apply HAVING filters to aggregated results.
 * HAVING is like WHERE but runs after aggregation.
 */
const applyHaving = (results: readonly Context[], having: readonly HavingClause[]): Context[] => {
  let filtered = [...results];
  for (const clause of having) {
    filtered = filtered.filter((ctx) => evaluatePredicate(clause, ctx));
  }
  return filtered;
};

// ─── ORDER BY ──────────────────────────────────────────────────────────────

/**
 * Sort results by the specified order.
 */
const applyOrderBy = (results: Context[], orderBy: readonly OrderBySpec[]): Context[] => {
  return results.sort((a, b) => {
    for (const { variable, direction } of orderBy) {
      const aVal = a[variable];
      const bVal = b[variable];

      if (aVal === bVal) continue;
      if (aVal === undefined) return 1;
      if (bVal === undefined) return -1;

      let cmp = 0;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal) < String(bVal) ? -1 : 1;
      }

      if ((direction ?? "asc") === "desc") cmp = -cmp;
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
};

// ─── LIMIT / OFFSET ───────────────────────────────────────────────────────

const applyLimitOffset = (results: Context[], limit?: number, offset?: number): Context[] => {
  const start = offset ?? 0;
  const end = limit !== undefined ? start + limit : undefined;
  return results.slice(start, end);
};

// ─── Main query execution ──────────────────────────────────────────────────

/**
 * Result of executing a Datalog query.
 */
export interface QueryResult {
  readonly results: readonly Context[];
}

/**
 * Execute a Datalog query against the KvTripleStore.
 *
 * Processing pipeline:
 * 1. WHERE → join contexts via pattern scans
 * 2. Find/actualize → extract result columns
 * 3. Aggregate → group + compute aggregates (if specified)
 * 4. HAVING → filter aggregated results (if specified)
 * 5. ORDER BY → sort results (if specified)
 * 6. LIMIT/OFFSET → paginate results (if specified)
 */
export const executeQuery = (
  store: KvTripleStore,
  query: DatalogQuery,
  rules: readonly Rule[] = [],
  options: { readonly asOf?: number } = {},
): Effect.Effect<QueryResult> => {
  return Effect.gen(function* () {
    // 1. Execute WHERE clauses
    const contexts = yield* executeWhere(store, query.where, rules, options.asOf);

    // 2. Extract find variables (and aggregate input variables)
    // When aggregation is requested, we must preserve aggregate input variables
    // in the actualized results so that the aggregate step can access them.
    let results: Context[];
    if (query.aggregate && query.aggregate.length > 0) {
      const aggregateInputVars = query.aggregate.map((a) => a[1]);
      const extendedFind = [
        ...query.find,
        ...aggregateInputVars.filter((v) => !query.find.includes(v)),
      ];
      results = actualize(contexts, extendedFind);
      results = aggregate(results, query.find, query.aggregate);
    } else {
      results = actualize(contexts, query.find);
    }

    results = yield* hydrateOptionalProjection(store, query, results, options.asOf);

    // 4. HAVING
    if (query.having && query.having.length > 0) {
      results = applyHaving(results, query.having);
    }

    // 5. ORDER BY
    if (query.orderBy && query.orderBy.length > 0) {
      results = applyOrderBy(results, query.orderBy);
    }

    // 6. LIMIT / OFFSET
    if (query.limit !== undefined || query.offset !== undefined) {
      results = applyLimitOffset(results, query.limit, query.offset);
    }

    return { results };
  });
};

// ─── Wrapper query execution ───────────────────────────────────────────────

/**
 * Result of executing a wrapped query.
 */
export interface WrappedQueryResult {
  readonly results: readonly Context[];
  readonly totalCount?: number;
  readonly nextCursor?: string;
}

/**
 * Execute a wrapped query with filtering, pagination, and optional count.
 *
 * Pipeline:
 * 1. Execute inner query
 * 2. Apply wrapper filters
 * 3. Compute total count (if requested, before pagination)
 * 4. Apply wrapper ORDER BY
 * 5. Apply cursor-based keyset pagination
 * 6. Apply wrapper LIMIT
 */
export const executeWrappedQuery = (
  store: KvTripleStore,
  query: WrappedQuery,
  rules: readonly Rule[] = [],
  options: { readonly asOf?: number } = {},
): Effect.Effect<WrappedQueryResult> => {
  return Effect.gen(function* () {
    // 1. Execute inner query
    const innerResult = yield* executeQuery(store, query.inner, rules, options);
    let results = [...innerResult.results] as Context[];

    // 2. Apply wrapper filters
    if (query.filters && query.filters.length > 0) {
      results = applyWrapperFilters(results, query.filters);
    }

    // 3. Total count (before pagination)
    const totalCount = query.includeCount ? results.length : undefined;

    // 4. Order by
    if (query.orderBy && query.orderBy.length > 0) {
      results = applyOrderBy(results, query.orderBy);
    }

    // 5. Cursor-based pagination
    if (query.cursor) {
      results = applyCursor(results, query.cursor, query.orderBy ?? []);
    }

    // 6. Limit (fetch one extra to determine if there's a next page)
    const limit = query.limit;
    let nextCursor: string | undefined;

    if (limit !== undefined) {
      if (results.length > limit) {
        results = results.slice(0, limit);
        // Encode cursor from the last result's order-by values
        const lastResult = results[results.length - 1];
        if (lastResult) {
          nextCursor = encodeCursor(lastResult, query.orderBy ?? []);
        }
      }
    }

    return {
      results,
      ...(totalCount !== undefined ? { totalCount } : {}),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  });
};

// ─── Wrapper filter evaluation ─────────────────────────────────────────────

const applyWrapperFilters = (results: Context[], filters: readonly WrapperFilter[]): Context[] => {
  let filtered = results;

  for (const filter of filters) {
    filtered = filtered.filter((ctx) => evaluateWrapperFilter(ctx, filter));
  }

  return filtered;
};

const evaluateWrapperFilter = (ctx: Context, filter: WrapperFilter): boolean => {
  const value = ctx[filter.column];

  switch (filter.op) {
    case "is-null":
      return value === undefined || value === null;
    case "is-not-null":
      return value !== undefined && value !== null;
    default:
      break;
  }

  // Remaining ops require a filter value
  if (filter.value === undefined) return true;
  if (value === undefined) return false;

  const filterVal = filter.value;

  switch (filter.op) {
    case "=":
      return value === filterVal;
    case "!=":
      return value !== filterVal;
    case ">":
      return typeof value === "number" && typeof filterVal === "number"
        ? value > filterVal
        : String(value) > String(filterVal);
    case ">=":
      return typeof value === "number" && typeof filterVal === "number"
        ? value >= filterVal
        : String(value) >= String(filterVal);
    case "<":
      return typeof value === "number" && typeof filterVal === "number"
        ? value < filterVal
        : String(value) < String(filterVal);
    case "<=":
      return typeof value === "number" && typeof filterVal === "number"
        ? value <= filterVal
        : String(value) <= String(filterVal);
    case "like":
      return typeof value === "string" && typeof filterVal === "string"
        ? likeMatch(value, filterVal, false)
        : false;
    case "not-like":
      return typeof value === "string" && typeof filterVal === "string"
        ? !likeMatch(value, filterVal, false)
        : true;
    case "ilike":
      return typeof value === "string" && typeof filterVal === "string"
        ? likeMatch(value, filterVal, true)
        : false;
    case "not-ilike":
      return typeof value === "string" && typeof filterVal === "string"
        ? !likeMatch(value, filterVal, true)
        : true;
    default:
      return true;
  }
};

/**
 * SQL LIKE pattern matching.
 * % matches any sequence of characters, _ matches any single character.
 */
const likeMatch = (value: string, pattern: string, caseInsensitive: boolean): boolean => {
  const v = caseInsensitive ? value.toLowerCase() : value;
  const p = caseInsensitive ? pattern.toLowerCase() : pattern;

  // Convert LIKE pattern to regex
  let regex = "^";
  for (const char of p) {
    if (char === "%") regex += ".*";
    else if (char === "_") regex += ".";
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";

  return new RegExp(regex, "s").test(v);
};

// ─── Cursor-based pagination ───────────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const encodeBase64Url = (bytes: Uint8Array): string => Encoding.encodeBase64Url(bytes);

const decodeBase64Url = (base64url: string): Uint8Array =>
  Result.getOrThrow(Encoding.decodeBase64Url(base64url));

/**
 * Encode a cursor from a result row.
 * The cursor captures the values of the ORDER BY columns for keyset pagination.
 */
const encodeCursor = (row: Context, orderBy: readonly OrderBySpec[]): string => {
  const values = orderBy.map(({ variable }) => row[variable] ?? null);
  const bytes = textEncoder.encode(JSON.stringify(values));
  return encodeBase64Url(bytes);
};

/**
 * Decode a cursor back to ORDER BY values.
 */
const decodeCursor = (cursor: string): Constant[] => {
  try {
    const bytes = decodeBase64Url(cursor);
    return JSON.parse(textDecoder.decode(bytes)) as Constant[];
  } catch {
    return [];
  }
};

/**
 * Apply cursor-based keyset pagination.
 * Filters results to only those "after" the cursor position.
 */
const applyCursor = (
  results: Context[],
  cursor: string,
  orderBy: readonly OrderBySpec[],
): Context[] => {
  const cursorValues = decodeCursor(cursor);
  if (cursorValues.length === 0 || orderBy.length === 0) return results;

  return results.filter((row) => {
    for (let i = 0; i < orderBy.length; i++) {
      const { variable, direction } = orderBy[i]!;
      const rowVal = row[variable];
      const curVal = cursorValues[i];

      if (rowVal === curVal) continue;
      if (rowVal === undefined) return false;
      if (curVal === undefined || curVal === null) return true;

      const isAsc = (direction ?? "asc") === "asc";

      if (typeof rowVal === "number" && typeof curVal === "number") {
        return isAsc ? rowVal > curVal : rowVal < curVal;
      }

      const cmp = String(rowVal) < String(curVal) ? -1 : 1;
      return isAsc ? cmp > 0 : cmp < 0;
    }
    return false; // All values equal to cursor — skip (already returned)
  });
};
