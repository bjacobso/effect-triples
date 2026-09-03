import { Schema } from "effect";
import type { TripleValue } from "../Value.js";
import type { EntityId } from "../Branded.js";

// Variable for pattern matching
export const Variable = Schema.Struct({
  _tag: Schema.Literal("Variable"),
  name: Schema.String,
});
export type Variable = typeof Variable.Type;

export const variable = (name: string): Variable => ({ _tag: "Variable", name });
export const v = variable; // shorthand

// Check if something is a variable
export const isVariable = (x: unknown): x is Variable =>
  typeof x === "object" && x !== null && "_tag" in x && x._tag === "Variable";

// Pattern for querying triples
export interface Pattern {
  readonly entityId?: EntityId | Variable;
  readonly attribute?: string | Variable;
  readonly value?: TripleValue | Variable;
  readonly entityType?: string;
}

// Resolved binding from pattern matching
export interface Binding {
  readonly [variable: string]: unknown;
}
