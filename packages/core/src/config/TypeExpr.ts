/**
 * The type algebra: attribute and entity types as *data*, not as code.
 *
 * `SchemaId` content-addresses an Effect Schema by hashing what
 * `JSONSchema.make` emits. That works, but it has two defects this module
 * exists to remove.
 *
 * First, identity is borrowed. Upgrading `effect` can move every id in the
 * store while not one type has changed, because the bytes being hashed are
 * someone else's serializer output. For a system of record that is not a
 * caveat, it is a bug.
 *
 * Second, and more fundamentally: an Effect Schema is a TypeScript value
 * written by a developer, and in this product **customers define attributes at
 * runtime**. `custom_properties.scalar_type` is a plain string column with
 * `enum_options` and `value_validation_regex` beside it, and 223 files in the
 * app know something about scalar types. The type language already exists - it
 * is just implicit, unversioned, and smeared across the codebase. Written down,
 * it becomes ordinary content-addressed config: a customer adding an enum
 * attribute produces a value, and that value is versioned, diffed and deployed
 * by exactly the machinery every other config node uses.
 *
 * The algebra is deliberately small and closed. That is what makes
 * `TypeSubsumption.subsumes` total rather than sound-but-incomplete: over a
 * language you define, "is every value of A also a value of B" is decidable, so
 * there is no `Unknown` verdict and no falling back to decoding instances. The
 * discipline to keep is that nothing here may grow into expressions or
 * computation - the moment the language can compute, subsumption stops being
 * decidable and the guarantee is gone.
 *
 * Each constructor carries its own `v`. Adding a constructor therefore leaves
 * every existing type's id untouched, and only types that actually use the new
 * one are affected. That is the merkle property applied to the type language
 * itself, and it is why the version lives on the node rather than on the
 * module.
 *
 * This module is the layer everything else would sit on: in a standalone repo
 * it is the zero-dependency package that both a triple store and a
 * content-addressed config graph depend on, while neither depends on the other.
 */

import { Schema } from "effect";

import * as CanonicalJson from "../content/CanonicalJson";
import * as ContentId from "../content/ContentId";

const TYPE_DOMAIN = ContentId.Domain.typeExpr;

/**
 * Scalars. `instant` is a point in time; `date` is a calendar date with no zone
 * - the distinction the app already draws for stored dates of birth, and one
 * you cannot recover later if both collapse to a single `datetime`.
 */
/** A literal usable as a struct field's fallback. */
export type Value = string | number | boolean;

export type PrimName = "text" | "number" | "integer" | "boolean" | "date" | "instant";

export interface Any {
  readonly _tag: "Any";
  readonly v: 1;
}
export interface Prim {
  readonly _tag: "Prim";
  readonly v: 1;
  readonly prim: PrimName;
}
export interface Enum {
  readonly _tag: "Enum";
  readonly v: 1;
  readonly values: ReadonlyArray<string>;
}
export interface Ref {
  readonly _tag: "Ref";
  readonly v: 1;
  readonly kind: string;
}
export interface List {
  readonly _tag: "List";
  readonly v: 1;
  readonly item: TypeExpr;
}
export interface StructField {
  readonly type: TypeExpr;
  readonly optional: boolean;
  /**
   * Filled in when the field is absent, before hashing.
   *
   * Normalisation, not validation: a fallback changes what bytes a value
   * canonicalises to, so it participates in identity, but it does not change
   * which values are accepted and therefore does not affect subsumption. That
   * split is what lets a config spelling a default out explicitly and one
   * omitting it share a content id.
   */
  readonly fallback?: Value;
}
export interface Struct {
  readonly _tag: "Struct";
  readonly v: 1;
  /** Closed: a value carrying a field not named here is invalid. */
  readonly fields: Readonly<Record<string, StructField>>;
}
export interface Union {
  readonly _tag: "Union";
  readonly v: 1;
  readonly members: ReadonlyArray<TypeExpr>;
}
export interface Constrained {
  readonly _tag: "Constrained";
  readonly v: 1;
  readonly base: TypeExpr;
  readonly constraints: ReadonlyArray<Constraint>;
}

export type TypeExpr = Any | Prim | Enum | Ref | List | Struct | Union | Constrained;

export type Constraint =
  | { readonly _tag: "Pattern"; readonly regex: string }
  | { readonly _tag: "MinLength"; readonly value: number }
  | { readonly _tag: "MaxLength"; readonly value: number }
  | { readonly _tag: "Min"; readonly value: number }
  | { readonly _tag: "Max"; readonly value: number };

// --- constructors -----------------------------------------------------------

export const any: Any = { _tag: "Any", v: 1 };

export const prim = (name: PrimName): Prim => ({ _tag: "Prim", v: 1, prim: name }); // prettier-ignore

export const text = prim("text");
export const number = prim("number");
export const integer = prim("integer");
export const boolean = prim("boolean");
export const date = prim("date");
export const instant = prim("instant");

/** Values are a set: order is not content and duplicates are not information. */
export const enumOf = (values: ReadonlyArray<string>): Enum => ({
  _tag: "Enum",
  v: 1,
  values: [...new Set(values)].sort(),
});

export const ref = (kind: string): Ref => ({ _tag: "Ref", v: 1, kind });

export const list = (item: TypeExpr): List => ({ _tag: "List", v: 1, item });

export const struct = (fields: Readonly<Record<string, StructField>>): Struct => ({
  _tag: "Struct",
  v: 1,
  fields,
});

export const required = (type: TypeExpr): StructField => ({
  type,
  optional: false,
});
export const optional = (type: TypeExpr, fallback?: Value): StructField =>
  fallback === undefined ? { type, optional: true } : { type, optional: true, fallback };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Members are a set, ordered canonically so `A | B` and `B | A` are one type. */
export const union = (members: ReadonlyArray<TypeExpr>): TypeExpr => {
  const flat = members.flatMap((m) => (m._tag === "Union" ? m.members : [m]));
  const seen = new Map<string, TypeExpr>();
  for (const member of flat) seen.set(canonical(member), member);
  const distinct = [...seen.entries()].sort(([a], [b]) => cmp(a, b)).map(([, m]) => m);
  return distinct.length === 1 ? distinct[0]! : { _tag: "Union", v: 1, members: distinct };
};

export const constrained = (base: TypeExpr, constraints: ReadonlyArray<Constraint>): TypeExpr => {
  if (constraints.length === 0) return base;
  // Nesting adds nothing a single constraint set cannot say.
  const inner = base._tag === "Constrained" ? base : null;
  const all = [...(inner?.constraints ?? []), ...constraints];
  const seen = new Map<string, Constraint>();
  for (const c of all) seen.set(CanonicalJson.encodeOrThrow(c), c);
  return {
    _tag: "Constrained",
    v: 1,
    base: inner ? inner.base : base,
    constraints: [...seen.entries()].sort(([a], [b]) => cmp(a, b)).map(([, c]) => c),
  };
};

export const pattern = (regex: string): Constraint => ({ _tag: "Pattern", regex }); // prettier-ignore
export const minLength = (value: number): Constraint => ({ _tag: "MinLength", value }); // prettier-ignore
export const maxLength = (value: number): Constraint => ({ _tag: "MaxLength", value }); // prettier-ignore
export const min = (value: number): Constraint => ({ _tag: "Min", value });
export const max = (value: number): Constraint => ({ _tag: "Max", value });

// --- identity ---------------------------------------------------------------

/**
 * Canonical bytes for a type. Constructors already normalise sets on the way
 * in, so this is a straight canonical encoding - the two halves together are
 * what make `A | B` and `B | A` a single id.
 */
export const canonical = (expr: TypeExpr): string =>
  CanonicalJson.encodeOrThrow(expr as unknown as CanonicalJson.CanonicalValue);

/** The type's content id. Owned end to end: no third-party serializer. */
export const id = (expr: TypeExpr): ContentId.ContentId =>
  ContentId.hash(TYPE_DOMAIN, canonical(expr));

// --- the language, described as data ----------------------------------------

/**
 * A schema for `TypeExpr` itself, so a type read back out of a store or off the
 * wire can be validated like anything else. Note the direction: this describes
 * the *language*, and is written once by us. The types customers create are
 * values of it.
 */
export const TypeExprSchema: Schema.Codec<TypeExpr> = Schema.suspend(
  (): Schema.Codec<TypeExpr> =>
    Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("Any"), v: Schema.Literal(1) }),
      Schema.Struct({
        _tag: Schema.Literal("Prim"),
        v: Schema.Literal(1),
        prim: Schema.Literals(["text", "number", "integer", "boolean", "date", "instant"]),
      }),
      Schema.Struct({
        _tag: Schema.Literal("Enum"),
        v: Schema.Literal(1),
        values: Schema.Array(Schema.String),
      }),
      Schema.Struct({
        _tag: Schema.Literal("Ref"),
        v: Schema.Literal(1),
        kind: Schema.String,
      }),
      Schema.Struct({
        _tag: Schema.Literal("List"),
        v: Schema.Literal(1),
        item: TypeExprSchema,
      }),
      Schema.Struct({
        _tag: Schema.Literal("Struct"),
        v: Schema.Literal(1),
        fields: Schema.Record(
          Schema.String,
          Schema.Struct({
            type: TypeExprSchema,
            optional: Schema.Boolean,
            fallback: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
          }),
        ),
      }),
      Schema.Struct({
        _tag: Schema.Literal("Union"),
        v: Schema.Literal(1),
        members: Schema.Array(TypeExprSchema),
      }),
      Schema.Struct({
        _tag: Schema.Literal("Constrained"),
        v: Schema.Literal(1),
        base: TypeExprSchema,
        constraints: Schema.Array(
          Schema.Union([
            Schema.Struct({
              _tag: Schema.Literal("Pattern"),
              regex: Schema.String,
            }),
            Schema.Struct({
              _tag: Schema.Literal("MinLength"),
              value: Schema.Number,
            }),
            Schema.Struct({
              _tag: Schema.Literal("MaxLength"),
              value: Schema.Number,
            }),
            Schema.Struct({
              _tag: Schema.Literal("Min"),
              value: Schema.Number,
            }),
            Schema.Struct({ _tag: Schema.Literal("Max"), value: Schema.Number }),
          ]),
        ),
      }),
    ]) as unknown as Schema.Codec<TypeExpr>,
);
