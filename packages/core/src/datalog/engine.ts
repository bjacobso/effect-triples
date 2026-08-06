/**
 * Core Datalog query engine
 *
 * Implements pattern matching and join semantics following the approach
 * described in https://www.instantdb.com/essays/datalogjs
 */

import { Effect } from "effect";
import { isVariable, isPredicateClause, isPatternClause } from "./schema.js";
import { evaluatePredicateSync } from "./predicates.js";
import type {
  Context,
  Term,
  Constant,
  PatternClause,
  PredicateClause,
  Clause,
  DatalogQuery,
  QueryResult,
  SimplifiedTriple,
} from "./types.js";
import { DatalogError } from "../errors/index.js";

// =============================================================================
// Pattern Matching
// =============================================================================

/**
 * Match a single pattern part against a triple part
 *
 * - If the pattern part is a variable:
 *   - If already bound in context, check if it matches the triple part
 *   - If not bound, bind it to the triple part
 * - If the pattern part is a constant, check for equality
 *
 * Returns the updated context or null if no match
 */
const matchPart = (
  patternPart: Term,
  triplePart: Constant,
  context: Context | null,
): Context | null => {
  // If we already failed, propagate the failure
  if (context === null) {
    return null;
  }

  if (isVariable(patternPart)) {
    // It's a variable
    if (patternPart in context) {
      // Already bound - check if it matches
      const boundValue = context[patternPart];
      return boundValue === triplePart ? context : null;
    }
    // Not bound - bind it
    return { ...context, [patternPart]: triplePart };
  }

  // It's a constant - check for equality
  return patternPart === triplePart ? context : null;
};

/**
 * Match a pattern against a single triple
 *
 * A pattern is [entity, attribute, value] or [entity, attribute, value, tx]
 * A triple is [entityId, attribute, value] or [entityId, attribute, value, txId]
 *
 * Returns the updated context with any new variable bindings,
 * or null if the pattern doesn't match
 */
export const matchPattern = (
  pattern: PatternClause,
  triple: SimplifiedTriple,
  context: Context,
): Context | null => {
  const [patternEntity, patternAttr, patternValue] = pattern;
  const patternTx = pattern.length === 4 ? pattern[3] : undefined;
  const [tripleEntity, tripleAttr, tripleValue] = triple;
  const tripleTx = triple.length === 4 ? triple[3] : null;

  let result: Context | null = context;
  result = matchPart(patternEntity, tripleEntity, result);
  result = matchPart(patternAttr, tripleAttr, result);
  result = matchPart(patternValue, tripleValue, result);

  // Match tx if pattern specifies it and triple has a tx
  if (patternTx !== undefined && result !== null) {
    if (tripleTx !== null) {
      result = matchPart(patternTx, tripleTx, result);
    } else {
      // Pattern wants tx but triple doesn't have one - no match
      result = null;
    }
  }

  return result;
};

// =============================================================================
// Single Pattern Query
// =============================================================================

/**
 * Query a single pattern against all triples
 * Returns all contexts that successfully match
 */
export const querySingle = (
  pattern: PatternClause,
  triples: readonly SimplifiedTriple[],
  context: Context,
): Context[] => {
  return triples
    .map((triple) => matchPattern(pattern, triple, context))
    .filter((ctx): ctx is Context => ctx !== null);
};

// =============================================================================
// Clause Processing
// =============================================================================

/**
 * Process a single clause (pattern or predicate) against current contexts
 *
 * - Pattern clauses: find matching triples and expand contexts
 * - Predicate clauses: filter contexts that satisfy the predicate
 */
const processClause = (
  clause: Clause,
  triples: readonly SimplifiedTriple[],
  contexts: Context[],
): Context[] => {
  if (isPredicateClause(clause)) {
    // Filter contexts by predicate
    return contexts.filter((ctx) => evaluatePredicateSync(clause as PredicateClause, ctx));
  }

  if (isPatternClause(clause)) {
    // Expand contexts by matching pattern against triples
    return contexts.flatMap((ctx) => querySingle(clause as PatternClause, triples, ctx));
  }

  // Shouldn't happen with valid schemas, but handle gracefully
  return contexts;
};

// =============================================================================
// Where Clause Processing (Joins)
// =============================================================================

/**
 * Process all where clauses, handling joins through shared variables
 *
 * This is the core of the Datalog engine. We start with an empty context
 * and progressively expand it by matching patterns and filtering with predicates.
 *
 * Shared variables between patterns create implicit joins:
 * ```
 * [["?movie", ":director", "?directorId"],
 *  ["?directorId", ":name", "?directorName"]]
 * ```
 * Here ?directorId is shared, creating a join between movies and directors.
 */
export const queryWhere = (
  clauses: readonly Clause[],
  triples: readonly SimplifiedTriple[],
): Context[] => {
  // Start with a single empty context
  let contexts: Context[] = [{}];

  for (const clause of clauses) {
    contexts = processClause(clause, triples, contexts);

    // Early exit if no contexts remain
    if (contexts.length === 0) {
      break;
    }
  }

  return contexts;
};

// =============================================================================
// Result Extraction
// =============================================================================

/**
 * Extract the find values from a context
 *
 * Given a context with bindings and a list of terms to find,
 * returns an object mapping variable names to their values.
 *
 * Only includes variables that are in the find list.
 */
export const actualize = (context: Context, find: readonly Term[]): Context => {
  const result: Record<string, Constant | null> = {};

  for (const term of find) {
    if (isVariable(term)) {
      if (term in context) {
        result[term] = context[term]!;
      } else {
        result[term] = null;
      }
    } else {
      // Constants in find are passed through as-is
      // This is unusual but allowed - use string representation as key
      result[String(term)] = term;
    }
  }

  return result;
};

// =============================================================================
// Main Query Function
// =============================================================================

/**
 * Execute a Datalog query against a set of triples
 *
 * @param q - The Datalog query with find and where clauses
 * @param triples - The triples to query against (simplified format)
 * @returns Array of result objects mapping variable names to values
 *
 * @example
 * ```typescript
 * const result = query({
 *   find: ["?name", "?age"],
 *   where: [
 *     ["?person", ":name", "?name"],
 *     ["?person", ":age", "?age"],
 *     [">=", "?age", 18]
 *   ]
 * }, triples)
 * // Returns: [{ "?name": "Alice", "?age": 30 }, ...]
 * ```
 */
export const query = (
  q: DatalogQuery,
  triples: readonly SimplifiedTriple[],
): Effect.Effect<QueryResult, DatalogError> => {
  return Effect.try({
    try: () => {
      // Run the where clauses to get all matching contexts
      const contexts = queryWhere(q.where, triples);

      // Extract the find values from each context
      const results = contexts.map((ctx) => actualize(ctx, q.find));

      // Remove duplicates (same bindings for find variables)
      const seen = new Set<string>();
      const uniqueResults: Context[] = [];

      for (const result of results) {
        const key = JSON.stringify(result);
        if (!seen.has(key)) {
          seen.add(key);
          uniqueResults.push(result);
        }
      }

      return uniqueResults;
    },
    catch: (error) =>
      new DatalogError({
        message: `Datalog query execution failed: ${String(error)}`,
        cause: error,
      }),
  });
};

/**
 * Execute a query synchronously (without Effect wrapper)
 * Useful for testing or when you don't need error handling
 */
export const querySync = (q: DatalogQuery, triples: readonly SimplifiedTriple[]): QueryResult => {
  const contexts = queryWhere(q.where, triples);
  const results = contexts.map((ctx) => actualize(ctx, q.find));

  // Remove duplicates
  const seen = new Set<string>();
  const uniqueResults: Context[] = [];

  for (const result of results) {
    const key = JSON.stringify(result);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueResults.push(result);
    }
  }

  return uniqueResults;
};
