import { Effect, Result, Schema } from "effect";
import { DatalogValidationError, UnboundVariableError } from "../errors/index.js";
import {
  DatalogQuery as DatalogQuerySchema,
  WrappedQuery as WrappedQuerySchema,
  isNotClause,
  isOrClause,
  isPatternClause,
  isPredicateClause,
  isRuleApplication,
  isTypedConstant,
  isVariable,
  normalizeOrAlternatives,
  type Clause,
  type DatalogQuery,
  type NotClause,
  type PatternClause,
  type PredicateClause,
  type Rule,
  type WrappedQuery,
} from "./schema.js";

export type DatalogQueryValidationError = DatalogValidationError | UnboundVariableError;

const invalid = (query: unknown, message: string, cause?: unknown): never => {
  throw new DatalogValidationError({ message, query, ...(cause === undefined ? {} : { cause }) });
};

const unbound = (variable: string, clause: unknown): never => {
  throw new UnboundVariableError({
    variable,
    clause,
    message: `Datalog variable ${variable} is not bound by a positive relation`,
  });
};

const decodeQuery = (input: unknown): DatalogQuery => {
  const decoded = Schema.decodeUnknownResult(DatalogQuerySchema)(input);
  if (Result.isFailure(decoded)) {
    return invalid(
      input,
      `Invalid Datalog query shape: ${decoded.failure.message}`,
      decoded.failure,
    );
  }
  return decoded.success;
};

const variablesInPattern = (pattern: PatternClause): readonly string[] =>
  pattern.filter(isVariable);

const requireBoundTerms = (clause: PredicateClause, bindings: ReadonlySet<string>): void => {
  for (const term of clause.slice(1)) {
    if (isVariable(term) && !bindings.has(term)) unbound(term, clause);
  }
};

const validateNot = (clause: NotClause, outerBindings: ReadonlySet<string>): void => {
  const localBindings = new Set(outerBindings);
  const inner = clause.slice(1) as readonly (PatternClause | PredicateClause)[];
  for (const candidate of inner) {
    if (isPatternClause(candidate as Clause)) {
      for (const variable of variablesInPattern(candidate as PatternClause)) {
        localBindings.add(variable);
      }
    }
  }
  for (const candidate of inner) {
    if (isPredicateClause(candidate as Clause)) {
      requireBoundTerms(candidate as PredicateClause, localBindings);
    }
  }
};

const validateRules = (query: DatalogQuery): ReadonlySet<string> => {
  const definitions = new Map<string, Rule[]>();
  for (const rule of query.rules ?? []) {
    const group = definitions.get(rule.name) ?? [];
    group.push(rule);
    definitions.set(rule.name, group);
  }

  for (const [name, rules] of definitions) {
    if (rules.some((rule) => rule.body.length === 0)) {
      invalid(query, `Datalog rule ${name} must have a non-empty body`);
    }
    if (!rules.some((rule) => !rule.body.some(isRuleApplication))) {
      invalid(query, `Datalog rule ${name} must have a non-recursive base definition`);
    }
    for (const rule of rules) {
      const patterns = rule.body.filter((clause) => !isRuleApplication(clause)) as PatternClause[];
      const applications = rule.body.filter(isRuleApplication);
      if (patterns.some((pattern) => pattern.length !== 3)) {
        invalid(query, `Datalog rule ${name} cannot bind transaction ids in rule bodies`);
      }
      const firstPattern = patterns[0];
      const lastPattern = patterns.at(-1);
      if (
        firstPattern === undefined ||
        lastPattern === undefined ||
        !isVariable(firstPattern[0]) ||
        !isVariable(lastPattern[2])
      ) {
        invalid(
          query,
          `Datalog rule ${name} must derive its two outputs from the first entity and last value variables`,
        );
      }
      for (const clause of rule.body) {
        if (isRuleApplication(clause) && clause[0] !== name) {
          invalid(
            query,
            `Datalog rule ${name} calls ${clause[0]}; cross-rule composition is not supported`,
          );
        }
      }
      if (applications.length > 0) {
        const pattern = patterns[0]!;
        const application = applications[0]!;
        if (
          rule.body.length !== 2 ||
          patterns.length !== 1 ||
          applications.length !== 1 ||
          rule.body[0] !== pattern ||
          rule.body[1] !== application ||
          !isVariable(pattern[0]) ||
          !isVariable(pattern[2]) ||
          !isVariable(application[1]) ||
          !isVariable(application[2]) ||
          pattern[2] !== application[1]
        ) {
          invalid(
            query,
            `Recursive Datalog rule ${name} must be [head, attribute, next] followed by [${name}, next, tail]`,
          );
        }
      }
    }
  }

  return new Set(definitions.keys());
};

const validateSemantics = (query: DatalogQuery): void => {
  const ruleNames = validateRules(query);
  const positiveBindings = new Set<string>();
  let hasPositiveRelation = false;

  for (const clause of query.where) {
    if (isPatternClause(clause)) {
      hasPositiveRelation = true;
      for (const variable of variablesInPattern(clause)) positiveBindings.add(variable);
    } else if (isRuleApplication(clause)) {
      hasPositiveRelation = true;
      if (!ruleNames.has(clause[0])) {
        invalid(query, `Datalog rule application ${clause[0]} has no definition`);
      }
      if (isVariable(clause[1])) positiveBindings.add(clause[1]);
      if (isVariable(clause[2])) positiveBindings.add(clause[2]);
    }
  }

  if (!hasPositiveRelation) {
    invalid(query, "Datalog query must contain a positive pattern or rule application");
  }

  for (const clause of query.where) {
    if (isPredicateClause(clause)) {
      requireBoundTerms(clause, positiveBindings);
    } else if (isNotClause(clause)) {
      validateNot(clause, positiveBindings);
    } else if (isOrClause(clause)) {
      const alternatives = normalizeOrAlternatives(clause);
      if (alternatives.length === 0) {
        invalid(query, "Datalog or clauses must contain at least one alternative");
      }
      for (const alternative of alternatives) {
        if (isPredicateClause(alternative as Clause)) {
          requireBoundTerms(alternative as PredicateClause, positiveBindings);
        } else if (isNotClause(alternative as Clause)) {
          validateNot(alternative as NotClause, positiveBindings);
        }
      }
    }
  }

  const aggregateSources = new Set<string>();
  const aggregateTargets = new Set<string>();
  for (const aggregate of query.aggregate ?? []) {
    const [, source, target] = aggregate;
    if (!positiveBindings.has(source)) unbound(source, aggregate);
    if (aggregateTargets.has(target)) {
      invalid(query, `Datalog aggregate target ${target} is declared more than once`);
    }
    if (positiveBindings.has(target)) {
      invalid(query, `Datalog aggregate target ${target} shadows a positive binding`);
    }
    if (!query.find.includes(target)) {
      invalid(query, `Datalog aggregate target ${target} must appear in find`);
    }
    aggregateSources.add(source);
    aggregateTargets.add(target);
  }

  const optionalTargets = new Set<string>();
  if (query.optionalProjection) {
    const { rowBinding, fields } = query.optionalProjection;
    if (!positiveBindings.has(rowBinding)) unbound(rowBinding, query.optionalProjection);
    for (const field of fields) {
      if (optionalTargets.has(field.variable)) {
        invalid(query, `Optional projection target ${field.variable} is declared more than once`);
      }
      if (positiveBindings.has(field.variable) || aggregateTargets.has(field.variable)) {
        invalid(query, `Optional projection target ${field.variable} shadows another binding`);
      }
      if (!query.find.includes(field.variable)) {
        invalid(query, `Optional projection target ${field.variable} must appear in find`);
      }
      optionalTargets.add(field.variable);
    }
  }

  const resultBindings = new Set<string>();
  for (const term of query.find) {
    if (!isVariable(term)) continue;
    if (resultBindings.has(term)) {
      invalid(query, `Datalog find variable ${term} is projected more than once`);
    }
    if (aggregateSources.has(term)) {
      invalid(query, `Datalog aggregate source ${term} cannot also appear in find`);
    }
    if (!positiveBindings.has(term) && !aggregateTargets.has(term) && !optionalTargets.has(term)) {
      unbound(term, { find: query.find });
    }
    resultBindings.add(term);
  }

  if ((query.having?.length ?? 0) > 0 && aggregateTargets.size === 0) {
    invalid(query, "Datalog having requires at least one aggregate");
  }
  for (const clause of query.having ?? []) requireBoundTerms(clause, resultBindings);

  for (const order of query.orderBy ?? []) {
    if (!resultBindings.has(order.variable)) unbound(order.variable, order);
  }
};

/** Decode and validate a query before selecting a backend execution strategy. */
export const assertDatalogQuery = (input: unknown): DatalogQuery => {
  const query = decodeQuery(input);
  validateSemantics(query);
  return query;
};

/** Effect form of {@link assertDatalogQuery} for public service boundaries. */
export const validateDatalogQuery = (
  input: unknown,
): Effect.Effect<DatalogQuery, DatalogQueryValidationError> =>
  Effect.try({
    try: () => assertDatalogQuery(input),
    catch: (cause) =>
      cause instanceof DatalogValidationError || cause instanceof UnboundVariableError
        ? cause
        : new DatalogValidationError({
            message: `Datalog query validation failed: ${String(cause)}`,
            query: input,
            cause,
          }),
  });

/** Validate wrapper shape and ensure filters/order reference projected inner columns. */
export const assertWrappedQuery = (input: unknown): WrappedQuery => {
  const decoded = Schema.decodeUnknownResult(WrappedQuerySchema)(input);
  if (Result.isFailure(decoded)) {
    return invalid(
      input,
      `Invalid wrapped Datalog query shape: ${decoded.failure.message}`,
      decoded.failure,
    );
  }
  const wrapped = decoded.success;
  const inner = assertDatalogQuery(wrapped.inner);
  const projected = new Set(inner.find.filter(isVariable));
  const numericResults = new Set(inner.aggregate?.map(([, , target]) => target) ?? []);
  for (const filter of wrapped.filters ?? []) {
    if (!projected.has(filter.column)) unbound(filter.column, filter);
    const isNullCheck = filter.op === "is-null" || filter.op === "is-not-null";
    const value = isTypedConstant(filter.value) ? filter.value.value : filter.value;
    if (isNullCheck && filter.value !== undefined) {
      invalid(input, `Wrapper filter ${filter.op} must not include a value`);
    }
    if (!isNullCheck && filter.value === undefined) {
      invalid(input, `Wrapper filter ${filter.op} requires a value`);
    }
    if (
      (filter.op === "like" ||
        filter.op === "not-like" ||
        filter.op === "ilike" ||
        filter.op === "not-ilike") &&
      typeof value !== "string"
    ) {
      invalid(input, `Wrapper filter ${filter.op} requires a string value`);
    }
    if (
      (filter.op === ">" || filter.op === ">=" || filter.op === "<" || filter.op === "<=") &&
      typeof value !== "number" &&
      typeof value !== "string"
    ) {
      invalid(input, `Wrapper filter ${filter.op} requires a number or string value`);
    }
    if (numericResults.has(filter.column) && !isNullCheck && typeof value !== "number") {
      invalid(input, `Wrapper filter on aggregate ${filter.column} requires a numeric value`);
    }
  }
  for (const order of wrapped.orderBy ?? []) {
    if (!projected.has(order.variable)) unbound(order.variable, order);
  }
  return { ...wrapped, inner };
};

export const validateWrappedQuery = (
  input: unknown,
): Effect.Effect<WrappedQuery, DatalogQueryValidationError> =>
  Effect.try({
    try: () => assertWrappedQuery(input),
    catch: (cause) =>
      cause instanceof DatalogValidationError || cause instanceof UnboundVariableError
        ? cause
        : new DatalogValidationError({
            message: `Wrapped Datalog query validation failed: ${String(cause)}`,
            query: input,
            cause,
          }),
  });
