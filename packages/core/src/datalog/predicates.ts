/**
 * Predicate evaluation for Datalog queries
 */

import { Effect } from "effect";
import { isVariable, type PredicateOp } from "./schema.js";
import type { Context, Term, PredicateClause, Constant } from "./types.js";
import { UnboundVariableError, InvalidPredicateError } from "../errors/index.js";

/**
 * Resolve a term to its value
 * - If it's a variable, look it up in the context
 * - If it's a constant, return it as-is
 */
export const resolveTerm = (
  term: Term,
  context: Context,
): Effect.Effect<Constant, UnboundVariableError> => {
  if (isVariable(term)) {
    if (term in context) {
      return Effect.succeed(context[term]!);
    }
    return Effect.fail(
      new UnboundVariableError({
        variable: term,
        clause: `Cannot resolve unbound variable: ${term}`,
      }),
    );
  }
  // It's a constant
  return Effect.succeed(term as Constant);
};

/**
 * Resolve a term synchronously (throws on error)
 * Used internally when we know the variable should be bound
 */
export const resolveTermSync = (term: Term, context: Context): Constant | null => {
  if (isVariable(term)) {
    return term in context ? context[term]! : null;
  }
  return term as Constant;
};

/**
 * Compare two values using the given operator
 */
const compare = (
  op: PredicateOp,
  left: Constant,
  right: Constant,
): Effect.Effect<boolean, InvalidPredicateError> => {
  // Type check: numeric comparisons require numbers
  if (op === ">" || op === ">=" || op === "<" || op === "<=") {
    if (typeof left !== "number" || typeof right !== "number") {
      return Effect.fail(
        new InvalidPredicateError({
          predicate: [op, left, right],
          message: `Numeric comparison '${op}' requires number operands, got ${typeof left} and ${typeof right}`,
        }),
      );
    }
  }

  switch (op) {
    case ">":
      return Effect.succeed((left as number) > (right as number));
    case ">=":
      return Effect.succeed((left as number) >= (right as number));
    case "<":
      return Effect.succeed((left as number) < (right as number));
    case "<=":
      return Effect.succeed((left as number) <= (right as number));
    case "=":
      return Effect.succeed(left === right);
    case "!=":
      return Effect.succeed(left !== right);
    default:
      return Effect.fail(
        new InvalidPredicateError({
          predicate: [op, left, right],
          message: `Unknown operator: ${op}`,
        }),
      );
  }
};

/**
 * Evaluate a predicate clause against the current context
 * Returns true if the predicate is satisfied, false otherwise
 */
export const evaluatePredicate = (
  predicate: PredicateClause,
  context: Context,
): Effect.Effect<boolean, UnboundVariableError | InvalidPredicateError> => {
  const [op, leftTerm, rightTerm] = predicate;

  return Effect.gen(function* () {
    const left = yield* resolveTerm(leftTerm, context);
    const right = yield* resolveTerm(rightTerm, context);
    return yield* compare(op as PredicateOp, left, right);
  });
};

/**
 * Evaluate a predicate synchronously
 * Returns true if satisfied, false if not satisfied or if there's an error
 * (errors are treated as "does not match" for filtering purposes)
 */
export const evaluatePredicateSync = (predicate: PredicateClause, context: Context): boolean => {
  const [op, leftTerm, rightTerm] = predicate;

  const left = resolveTermSync(leftTerm, context);
  const right = resolveTermSync(rightTerm, context);

  // If either term couldn't be resolved, predicate fails
  if (left === null || right === null) {
    return false;
  }

  // Type check for numeric operators
  if (op === ">" || op === ">=" || op === "<" || op === "<=") {
    if (typeof left !== "number" || typeof right !== "number") {
      return false;
    }
  }

  switch (op) {
    case ">":
      return (left as number) > (right as number);
    case ">=":
      return (left as number) >= (right as number);
    case "<":
      return (left as number) < (right as number);
    case "<=":
      return (left as number) <= (right as number);
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return false;
  }
};
