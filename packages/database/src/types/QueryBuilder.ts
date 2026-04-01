import { Effect } from "effect";
import { TripleStore } from "../store/TripleStore.js";
import type { Triple } from "@open-ontology/database";
import type { Filter, SortSpec } from "./Filter.js";
import type { ReadError, QueryError } from "../errors/index.js";

// Operator types
type ComparisonOp = "=" | "!=" | ">" | ">=" | "<" | "<=";
type StringOp = "contains" | "startsWith";
type ArrayOp = "in";
type ExistenceOp = "exists" | "notExists";

// All supported operators
export type QueryOperator = ComparisonOp | StringOp | ArrayOp | ExistenceOp;

// Immutable query state
export interface QueryState {
  readonly entityType: string;
  readonly filters: readonly Filter[];
  readonly sorts: readonly SortSpec[];
  readonly limit?: number;
  readonly offset?: number;
}

// Validate attribute starts with ":"
const validateAttribute = (attr: string): void => {
  if (!attr.startsWith(":")) {
    throw new Error(`Attribute must start with ":", got: "${attr}"`);
  }
};

/**
 * Fluent query builder for triple store queries.
 *
 * @example
 * ```typescript
 * const results = yield* Query.from("Person")
 *   .where(":age", ">=", 21)
 *   .where(":status", "=", "active")
 *   .orderBy(":name", "asc")
 *   .limit(10)
 *   .run()
 * ```
 */
export class Query {
  private constructor(private readonly state: QueryState) {}

  /**
   * Start building a query for entities of the given type.
   */
  static from(entityType: string): Query {
    return new Query({ entityType, filters: [], sorts: [] });
  }

  /**
   * Add a filter condition.
   *
   * Supported operators:
   * - Comparison: "=", "!=", ">", ">=", "<", "<="
   * - String: "contains", "startsWith"
   * - Array: "in"
   * - Existence: "exists", "notExists"
   *
   * @param attribute - The attribute to filter on (must start with ":")
   * @param op - The operator to use
   * @param value - The value to compare against (not needed for exists/notExists)
   */
  where(attribute: string, op: ComparisonOp, value: string | number | boolean): Query;
  where(attribute: string, op: StringOp, value: string): Query;
  where(attribute: string, op: ArrayOp, values: readonly (string | number | boolean)[]): Query;
  where(attribute: string, op: ExistenceOp): Query;
  where(attribute: string, op: string, value?: unknown): Query {
    validateAttribute(attribute);
    const filter = this.opToFilter(attribute, op, value);
    return new Query({
      ...this.state,
      filters: [...this.state.filters, filter],
    });
  }

  /**
   * Add a sort specification.
   *
   * @param attribute - The attribute to sort by (must start with ":")
   * @param direction - Sort direction, defaults to "asc"
   */
  orderBy(attribute: string, direction: "asc" | "desc" = "asc"): Query {
    validateAttribute(attribute);
    return new Query({
      ...this.state,
      sorts: [...this.state.sorts, { attribute, direction }],
    });
  }

  /**
   * Limit the number of results.
   */
  limit(n: number): Query {
    return new Query({ ...this.state, limit: n });
  }

  /**
   * Skip the first N results.
   */
  offset(n: number): Query {
    return new Query({ ...this.state, offset: n });
  }

  /**
   * Execute the query against the TripleStore.
   *
   * Returns all triples for matching entities.
   */
  run(): Effect.Effect<readonly Triple[], ReadError | QueryError, TripleStore> {
    return Effect.flatMap(TripleStore, (store) => store.queryWithBuilder(this.state));
  }

  /**
   * Get the current query state (useful for debugging or serialization).
   */
  getState(): QueryState {
    return this.state;
  }

  // Convert operator string to Filter type
  // TODO: Add runtime validation of value types in future iteration
  private opToFilter(attr: string, op: string, value?: unknown): Filter {
    switch (op) {
      case "=":
        return { type: "eq", attribute: attr, value };
      case "!=":
        return { type: "neq", attribute: attr, value };
      case ">":
        return { type: "gt", attribute: attr, value: value as number };
      case ">=":
        return { type: "gte", attribute: attr, value: value as number };
      case "<":
        return { type: "lt", attribute: attr, value: value as number };
      case "<=":
        return { type: "lte", attribute: attr, value: value as number };
      case "contains":
        return { type: "contains", attribute: attr, value: value as string };
      case "startsWith":
        return { type: "startsWith", attribute: attr, value: value as string };
      case "in":
        return { type: "in", attribute: attr, values: value as readonly unknown[] };
      case "exists":
        return { type: "exists", attribute: attr };
      case "notExists":
        return { type: "notExists", attribute: attr };
      default:
        throw new Error(`Unknown operator: ${op}`);
    }
  }
}
