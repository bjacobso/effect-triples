/**
 * Framework layer: content-addressing an Effect Schema through its JSON Schema
 * projection, and which differences are meant to move the id.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as SchemaId from "./SchemaId";

describe("SchemaId", () => {
  const Field = Schema.Struct({
    path: Schema.String,
    type: Schema.Literal("ssn", "text"),
    required: Schema.Boolean,
  });

  it.effect("is stable across cosmetic reordering of set-valued keywords", () =>
    Effect.gen(function* () {
      // `required` and `enum` are sets in JSON Schema, so swapping two struct
      // fields or two literals must not read as a shape change.
      const reordered = Schema.Struct({
        required: Schema.Boolean,
        type: Schema.Literal("text", "ssn"),
        path: Schema.String,
      });

      const a = yield* SchemaId.of(Field);
      const b = yield* SchemaId.of(reordered);

      expect(a.cid).toEqual(b.cid);
    })
  );

  it.effect("moves when the shape actually changes", () =>
    Effect.gen(function* () {
      const widened = Schema.Struct({
        path: Schema.String,
        type: Schema.Literal("ssn", "text", "routing_number"),
        required: Schema.Boolean,
      });
      const optional = Schema.Struct({
        path: Schema.String,
        type: Schema.Literal("ssn", "text"),
        required: Schema.optional(Schema.Boolean),
      });

      const base = yield* SchemaId.of(Field);
      expect((yield* SchemaId.of(widened)).cid).not.toEqual(base.cid);
      expect((yield* SchemaId.of(optional)).cid).not.toEqual(base.cid);
    })
  );

  it.effect(
    "keeps the JSON Schema it hashed, so old objects stay readable",
    () =>
      Effect.gen(function* () {
        const { jsonSchema } = yield* SchemaId.of(Field);
        // This is what gets written to the schema log next to the object; a
        // snapshot taken today can be re-parsed years later through this exact
        // shape rather than through whatever the code says by then.
        expect(jsonSchema).toMatchObject({
          type: "object",
          required: ["path", "required", "type"],
        });
      })
  );

  it.effect("fails on a schema with no JSON Schema projection", () =>
    Effect.gen(function* () {
      const opaque = Schema.declare(
        (input: unknown): input is Map<string, string> => input instanceof Map
      );
      const error = yield* SchemaId.of(opaque).pipe(Effect.flip);
      expect(error._tag).toEqual("SchemaNotRepresentableError");
    })
  );
});
