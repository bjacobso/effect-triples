/**
 * Compiling a `TypeExpr` down to an Effect Schema.
 *
 * The point of writing our own type language was never to leave Effect Schema
 * behind - it was to stop borrowing *identity* from it. So the relationship is
 * one-directional and explicit: `TypeExpr` is the source of truth, and Schema
 * is a compilation target, alongside whatever else needs one (JSON Schema for
 * docs, a widget for the form builder, DDL for a relational mirror).
 *
 *     TypeExpr ──► Schema      decoding, parse errors, effect-form, HttpApi
 *        │    ──► JSON Schema  external contracts
 *        └── canonical ──► ContentId   identity, owned end to end
 *
 * Everything Effect Schema is good at survives. What does not survive - and
 * cannot, by construction - is a precise *static* type. A type a customer
 * created at 3pm has no TypeScript counterpart, so the result decodes to
 * `unknown` and callers narrow it themselves. That is not a shortcoming of the
 * compiler; it is what "types are runtime data" means.
 */

import { Effect, ParseResult, Schema } from "effect";

import * as TypeExpr from "./TypeExpr";

/** ISO calendar date with no zone - distinct from an instant, on purpose. */
const IsoDate = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}$/, {
    message: () => "Expected an ISO calendar date (YYYY-MM-DD)",
  })
);

const primSchema = (name: TypeExpr.PrimName): Schema.Schema<any, any> => {
  switch (name) {
    case "text":
      return Schema.String;
    case "number":
      return Schema.Number;
    case "integer":
      return Schema.Number.pipe(Schema.int());
    case "boolean":
      return Schema.Boolean;
    case "date":
      return IsoDate;
    case "instant":
      return Schema.Number.pipe(Schema.int());
  }
};

const applyConstraint = (
  schema: Schema.Schema<any, any>,
  constraint: TypeExpr.Constraint
): Schema.Schema<any, any> => {
  switch (constraint._tag) {
    case "Pattern":
      return (schema as Schema.Schema<string, string>).pipe(
        Schema.pattern(new RegExp(constraint.regex))
      ) as Schema.Schema<any, any>;
    case "MinLength":
      return (schema as Schema.Schema<string, string>).pipe(
        Schema.minLength(constraint.value)
      ) as Schema.Schema<any, any>;
    case "MaxLength":
      return (schema as Schema.Schema<string, string>).pipe(
        Schema.maxLength(constraint.value)
      ) as Schema.Schema<any, any>;
    case "Min":
      return (schema as Schema.Schema<number, number>).pipe(
        Schema.greaterThanOrEqualTo(constraint.value)
      ) as Schema.Schema<any, any>;
    case "Max":
      return (schema as Schema.Schema<number, number>).pipe(
        Schema.lessThanOrEqualTo(constraint.value)
      ) as Schema.Schema<any, any>;
  }
};

const go = (expr: TypeExpr.TypeExpr): Schema.Schema<any, any> => {
  switch (expr._tag) {
    case "Any":
      return Schema.Unknown as Schema.Schema<any, any>;
    case "Prim":
      return primSchema(expr.prim);
    case "Enum":
      // A one-value enum is a literal, not a union of one.
      return Schema.Literal(...expr.values) as Schema.Schema<any, any>;
    case "Ref":
      // A reference is a key addressing another entity; the target is resolved
      // by the store, not by decoding.
      return Schema.String as Schema.Schema<any, any>;
    case "List":
      return Schema.Array(go(expr.item)) as Schema.Schema<any, any>;
    case "Struct":
      return Schema.Struct(
        Object.fromEntries(
          Object.entries(expr.fields).map(([name, field]) => [
            name,
            field.optional
              ? field.fallback === undefined
                ? Schema.optional(go(field.type))
                : // Applied on decode and emitted on encode, so an omitted
                  // field and an explicitly-defaulted one produce identical
                  // bytes and therefore an identical content id.
                  Schema.optionalWith(go(field.type), {
                    default: () => field.fallback,
                  })
              : go(field.type),
          ])
        )
        // Structs are closed, and `TypeSubsumption` decides verdicts on that
        // basis - dropping a field narrows precisely because a value still
        // carrying it must be rejected. Effect ignores excess properties by
        // default, so without this the two halves would disagree: subsumption
        // would refuse a change the compiler would happily accept. Annotating
        // the node rather than passing parse options means every caller of
        // `compile` gets the same semantics, including nested uses.
      ).annotations({
        parseOptions: { onExcessProperty: "error" },
      }) as unknown as Schema.Schema<any, any>;
    case "Union":
      return Schema.Union(...expr.members.map(go)) as unknown as Schema.Schema<
        any,
        any
      >;
    case "Constrained":
      return expr.constraints.reduce(applyConstraint, go(expr.base));
  }
};

/**
 * Compile to a Schema that decodes to `unknown`.
 *
 * Deliberately not generic over a success type. Offering `compile<A>()` would
 * let a caller assert a static shape the runtime value need not have, which is
 * exactly the unsoundness this whole direction exists to avoid.
 */
export const compile = (
  expr: TypeExpr.TypeExpr
): Schema.Schema<unknown, unknown> =>
  go(expr) as unknown as Schema.Schema<unknown, unknown>;

/** Does this value satisfy the type? The instance-level check, when needed. */
export const is = (expr: TypeExpr.TypeExpr, value: unknown): boolean =>
  Schema.is(compile(expr))(value);

/**
 * Validate a value and return its normalised (encoded) form.
 *
 * Decode then re-encode, so the type's own fallbacks are applied and anything
 * the type considers irrelevant is discarded. Hashing this rather than the raw
 * input is what makes two configs differing only in ways the type ignores come
 * out byte-identical.
 */
export const normalize = (
  expr: TypeExpr.TypeExpr,
  input: unknown
): Effect.Effect<unknown, ParseResult.ParseError> => {
  const schema = compile(expr);
  return Schema.decodeUnknown(schema)(input).pipe(
    Effect.flatMap((decoded) => Schema.encode(schema)(decoded))
  );
};
