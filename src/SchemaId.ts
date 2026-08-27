/**
 * Content-addressed Effect Schemas: the shape half of the config graph.
 *
 * A `ConfigNode` carries the *data* that was projected out of the database.
 * This module carries the *shape that data was validated against* - the
 * `SchemaId` is the content id of the JSON Schema that `JSONSchema.make`
 * derives from an Effect Schema. Because it is derived from the running code,
 * it moves the moment a projector's schema moves, with no constant to remember
 * to bump.
 *
 * The point is the log it makes possible. Every projection records both ids, so
 * `config_schemas` becomes an append-only record of every shape this system has
 * ever written objects under, and any historical object can be read back
 * through the exact schema that produced it rather than through today's. That
 * is what makes an old snapshot replayable instead of merely archived: schema
 * evolution stops being a migration and becomes a lookup.
 *
 * Two normalisations keep the id tracking meaning rather than source text.
 * `required` and `enum` are sets in JSON Schema, but Effect emits them in
 * declaration order, so reordering two struct fields or two literals would
 * otherwise look like a schema change. Everything else keeps its order, because
 * `anyOf` / `allOf` / tuple positions are not sets and reordering them can
 * change what validates.
 *
 * The honest caveat: this id is a hash of Effect's JSON Schema *emitter*
 * output, so upgrading `effect` can move it while every schema in the repo is
 * untouched. That is a review event, not an error - the log will show one
 * shape superseding another with an identical meaning, and the deploy tooling
 * should let a human record the two as equivalent rather than treat the churn
 * as a config change.
 */

import { Data, Effect, JSONSchema, ParseResult, Schema } from "effect";

import * as CanonicalJson from "./CanonicalJson";
import * as ContentId from "./ContentId";

const SCHEMA_DOMAIN = "config-graph/schema";

export class SchemaNotRepresentableError extends Data.TaggedError(
  "SchemaNotRepresentableError"
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface SchemaDescriptor {
  readonly cid: ContentId.ContentId;
  /** The normalised JSON Schema this id was computed over. Persist verbatim. */
  readonly jsonSchema: CanonicalJson.CanonicalValue;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sort the two JSON Schema keywords that are defined as sets, at any depth. */
const normalize = (value: unknown): CanonicalJson.CanonicalValue => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== "object") {
    return value as CanonicalJson.CanonicalValue;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
      if ((key === "required" || key === "enum") && Array.isArray(nested)) {
        return [
          key,
          [...nested]
            .map(normalize)
            .sort((a, b) =>
              cmp(
                CanonicalJson.encodeOrThrow(a),
                CanonicalJson.encodeOrThrow(b)
              )
            ),
        ];
      }
      return [key, normalize(nested)];
    })
  );
};

// Projection schemas are module-level singletons, so keying the cache on the
// schema object itself is enough to make this a one-time cost per process.
const cache = new WeakMap<object, SchemaDescriptor>();

/**
 * The content id of `schema`'s JSON Schema projection.
 *
 * Fails for schemas `JSONSchema.make` cannot represent - most often a
 * `Schema.transform` with no JSON-Schema counterpart, or a `Schema.declare`
 * over an opaque class. Projection schemas must stay representable: a shape
 * that cannot be written down cannot be logged, and an object hashed under an
 * unwritable shape cannot be replayed later.
 */
export const of = (
  schema: Schema.Schema.Any
): Effect.Effect<
  SchemaDescriptor,
  SchemaNotRepresentableError | CanonicalJson.CanonicalEncodingError
> =>
  Effect.gen(function* () {
    const cached = cache.get(schema as unknown as object);
    if (cached) return cached;

    const jsonSchema = yield* Effect.try({
      try: () => normalize(JSONSchema.make(schema)),
      catch: (cause) =>
        new SchemaNotRepresentableError({
          message: `Schema has no JSON Schema projection, so it cannot be content-addressed: ${String(cause)}`,
          cause,
        }),
    });

    const encoded = yield* CanonicalJson.encode(jsonSchema);
    const descriptor: SchemaDescriptor = {
      cid: ContentId.hash(SCHEMA_DOMAIN, encoded),
      jsonSchema,
    };

    cache.set(schema as unknown as object, descriptor);
    return descriptor;
  });

/**
 * Validate `input` against `schema` and return the encoded (wire) form.
 *
 * Hashing the encoded form rather than the decoded one is deliberate. It is the
 * shape the JSON Schema actually describes, it is what round-trips through the
 * database, and it means a schema's own transformations normalise the data on
 * the way in: defaults are filled, optional-undefined is dropped, and branded
 * strings collapse to strings. Two configs that differ only in ways the schema
 * considers irrelevant come out byte-identical, and therefore hash-identical.
 */
export const normalizeThrough = <A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown
): Effect.Effect<CanonicalValueOf<I>, ParseResult.ParseError> =>
  Schema.decodeUnknown(schema)(input).pipe(
    Effect.flatMap((decoded) => Schema.encode(schema)(decoded)),
    Effect.map((encoded) => encoded as CanonicalValueOf<I>)
  );

type CanonicalValueOf<I> = I & CanonicalJson.CanonicalValue;
