/** Globally identified runtime attribute definitions and usage-local constraints. */

import { Effect, type Schema } from "effect";

import type { TripleValue } from "../Value.js";
import type { EntityId } from "../Branded.js";
import * as Values from "../Value.js";
import * as ConfigNode from "./ConfigNode.js";
import * as TypeExpr from "./TypeExpr.js";

export const KIND = "attribute";

const ATTRIBUTE_KEY = /^:[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;

export interface AssertionOptions {
  /** Domain-valid time carried by the assertion descriptor. */
  readonly validFrom?: number;
}

export interface Assertion<K extends string = string> {
  readonly attribute: K;
  readonly value: TripleValue;
  readonly validFrom?: number;
}

export interface Definition<K extends string, V> {
  readonly _tag: "Attribute";
  readonly key: K;
  readonly type: TypeExpr.TypeExpr;
  readonly node: Effect.Effect<
    ConfigNode.ConfigNode,
    | ConfigNode.DuplicateChildKeyError
    | import("../content/CanonicalJson.js").CanonicalEncodingError
    | Schema.SchemaError
  >;
  readonly encode: (value: V) => TripleValue;
}

export interface UseOptions {
  readonly required?: boolean;
  readonly cardinality?: "one" | "many";
  /** Values of this attribute may occur on at most one entity of this type. */
  readonly unique?: boolean;
}

export interface Use<D extends Definition<string, unknown>> {
  readonly _tag: "AttributeUse";
  readonly attribute: D;
  readonly required: boolean;
  readonly cardinality: "one" | "many";
  readonly unique: boolean;
}

export type AnyDefinition = Definition<string, any>;
export type ValueOf<D> = D extends Definition<string, infer V> ? V : never;

const DefinitionType = TypeExpr.struct({
  key: TypeExpr.required(TypeExpr.text),
  valueType: TypeExpr.required(TypeExpr.any),
});

const validateKey = <const K extends string>(key: K): K => {
  if (!ATTRIBUTE_KEY.test(key)) {
    throw new TypeError(
      `Attribute identity must be a lowercase namespaced keyword such as :employer/name; received ${key}`,
    );
  }
  return key;
};

const make = <const K extends string, V>(
  keyInput: K,
  type: TypeExpr.TypeExpr,
  encode: (value: V) => TripleValue,
  refs: ReadonlyArray<ConfigNode.ConfigRef> = [],
): Definition<K, V> => {
  const key = validateKey(keyInput);
  return {
    _tag: "Attribute",
    key,
    type,
    encode,
    node: ConfigNode.makeTyped({
      kind: KIND,
      key,
      type: DefinitionType,
      attrs: { key, valueType: type },
      refs,
    }),
  };
};

export const text = <const K extends string>(key: K): Definition<K, string> =>
  make(key, TypeExpr.text, Values.string);

export const number = <const K extends string>(key: K): Definition<K, number> =>
  make(key, TypeExpr.number, Values.number);

export const integer = <const K extends string>(key: K): Definition<K, number> =>
  make(key, TypeExpr.integer, Values.number);

export const boolean = <const K extends string>(key: K): Definition<K, boolean> =>
  make(key, TypeExpr.boolean, Values.boolean);

export const date = <const K extends string>(key: K): Definition<K, string> =>
  make(key, TypeExpr.date, Values.string);

export const instant = <const K extends string>(key: K): Definition<K, number | Date> =>
  make(key, TypeExpr.instant, Values.datetime);

export const enumOf = <const K extends string, const V extends string>(
  key: K,
  values: ReadonlyArray<V>,
): Definition<K, V> => make(key, TypeExpr.enumOf(values), (value) => Values.string(value));

/** A relation attribute whose values are entity ids of `target`. */
export const ref = <const K extends string, const Target extends { readonly entityType: string }>(
  key: K,
  target: Target,
): Definition<K, EntityId> =>
  make(key, TypeExpr.ref(target.entityType), Values.ref, [
    {
      rel: "references-entity-type",
      kind: "entity-schema",
      key: target.entityType,
    },
  ]);

/** Requiredness and cardinality belong to an entity's use, not the global attribute. */
export const use = <D extends AnyDefinition>(attribute: D, options: UseOptions = {}): Use<D> => ({
  _tag: "AttributeUse",
  attribute,
  required: options.required ?? false,
  cardinality: options.cardinality ?? "one",
  unique: options.unique ?? false,
});

export const assertion = <D extends AnyDefinition>(
  definition: D,
  value: ValueOf<D>,
  options: AssertionOptions = {},
): Assertion<D["key"]> => {
  if (options.validFrom !== undefined && !Number.isFinite(options.validFrom)) {
    throw new TypeError("validFrom must be a finite epoch-millisecond value");
  }
  return {
    attribute: definition.key,
    value: definition.encode(value),
    ...(options.validFrom !== undefined && { validFrom: options.validFrom }),
  };
};
