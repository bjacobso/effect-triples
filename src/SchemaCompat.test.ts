import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as SchemaCompat from "./SchemaCompat";
import * as SchemaId from "./SchemaId";

const verdict = (
  from: Schema.Schema.AnyNoContext,
  to: Schema.Schema.AnyNoContext
) =>
  // prettier-ignore
  Effect.gen(function* () {
    return SchemaCompat.subsumes(yield* SchemaId.of(from), yield* SchemaId.of(to)); // prettier-ignore
  });

const Base = Schema.Struct({
  path: Schema.String,
  label: Schema.String,
  required: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});

describe("SchemaCompat.subsumes", () => {
  it.effect("proves a widening when a new optional property appears", () =>
    Effect.gen(function* () {
      // The case that motivated this: v2 adds an optional string, so every
      // instance written under v1 is still valid and nothing needs revisiting.
      const widened = Schema.Struct({
        ...Base.fields,
        helpText: Schema.optional(Schema.String),
      });

      const result = yield* verdict(Base, widened);
      expect(result._tag).toEqual("Widens");
      expect(SchemaCompat.isCompatible(result)).toBe(true);
      expect(result._tag === "Widens" && result.reasons.join(" ")).toContain(
        "helpText"
      );
    })
  );

  it.effect("proves a narrowing when that property becomes required", () =>
    Effect.gen(function* () {
      const tightened = Schema.Struct({
        ...Base.fields,
        helpText: Schema.String,
      });

      const result = yield* verdict(Base, tightened);
      expect(result._tag).toEqual("Narrows");
      expect(SchemaCompat.isCompatible(result)).toBe(false);
      expect(result._tag === "Narrows" && result.reasons.join(" ")).toContain(
        "now requires helpText"
      );
    })
  );

  it.effect("treats relaxing a requirement as a widening", () =>
    Effect.gen(function* () {
      const relaxed = Schema.Struct({
        path: Schema.String,
        label: Schema.optional(Schema.String),
        required: Schema.optionalWith(Schema.Boolean, { default: () => true }),
      });

      expect((yield* verdict(Base, relaxed))._tag).toEqual("Widens");
      expect((yield* verdict(relaxed, Base))._tag).toEqual("Narrows");
    })
  );

  it.effect("follows literal unions in both directions", () =>
    Effect.gen(function* () {
      const three = Schema.Struct({ type: Schema.Literal("a", "b", "c") });
      const two = Schema.Struct({ type: Schema.Literal("a", "b") });

      expect((yield* verdict(two, three))._tag).toEqual("Widens");

      const narrowed = yield* verdict(three, two);
      expect(narrowed._tag).toEqual("Narrows");
      expect(
        narrowed._tag === "Narrows" && narrowed.reasons.join(" ")
      ).toContain("no longer allows");
    })
  );

  it.effect("rejects a changed scalar type outright", () =>
    Effect.gen(function* () {
      const asNumber = Schema.Struct({ ...Base.fields, label: Schema.Number });
      expect((yield* verdict(Base, asNumber))._tag).toEqual("Narrows");
    })
  );

  it.effect("catches a dropped property on a closed schema", () =>
    Effect.gen(function* () {
      // `additionalProperties: false` means an instance still carrying the
      // dropped property is rejected, so removing a field is not free.
      const fewer = Schema.Struct({
        path: Schema.String,
        label: Schema.String,
      });
      const result = yield* verdict(Base, fewer);
      expect(result._tag).toEqual("Narrows");
      expect(result._tag === "Narrows" && result.reasons.join(" ")).toContain(
        "no longer accepts property required"
      );
    })
  );

  it.effect("recurses through nested structs and arrays", () =>
    Effect.gen(function* () {
      const nested = Schema.Struct({
        page: Schema.Struct({ title: Schema.String }),
        tags: Schema.Array(Schema.Struct({ name: Schema.String })),
      });
      const nestedWidened = Schema.Struct({
        page: Schema.Struct({
          title: Schema.String,
          subtitle: Schema.optional(Schema.String),
        }),
        tags: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            color: Schema.optional(Schema.String),
          })
        ),
      });

      expect((yield* verdict(nested, nestedWidened))._tag).toEqual("Widens");
      expect((yield* verdict(nestedWidened, nested))._tag).toEqual("Narrows");
    })
  );

  it.effect("resolves $ref into $defs", () =>
    Effect.gen(function* () {
      class Field extends Schema.Class<Field>("Field")({
        path: Schema.String,
      }) {}
      class FieldV2 extends Schema.Class<FieldV2>("Field")({
        path: Schema.String,
        help: Schema.optional(Schema.String),
      }) {}

      const from = Schema.Struct({ field: Field });
      const to = Schema.Struct({ field: FieldV2 });
      expect((yield* verdict(from, to))._tag).toEqual("Widens");
    })
  );

  it.effect("says Unknown rather than guessing on unmodelled keywords", () =>
    Effect.gen(function* () {
      // Soundness over coverage. A caller seeing `Unknown` validates real
      // instances; a caller seeing a wrong `Widens` ships broken config.
      const constrained = Schema.Struct({
        ...Base.fields,
        label: Schema.String.pipe(Schema.minLength(1)),
      });
      const result = yield* verdict(Base, constrained);
      expect(result._tag).toEqual("Unknown");
      expect(SchemaCompat.isCompatible(result)).toBe(false);

      // Unions are outside the modelled fragment too.
      const union = Schema.Struct({
        value: Schema.Union(Schema.String, Schema.Number),
      });
      const stringOnly = Schema.Struct({ value: Schema.String });
      expect((yield* verdict(stringOnly, union))._tag).toEqual("Unknown");
    })
  );

  it.effect("reports identical shapes as identical", () =>
    Effect.gen(function* () {
      const same = Schema.Struct({ ...Base.fields });
      expect((yield* verdict(Base, same))._tag).toEqual("Identical");
    })
  );
});

describe("SchemaCompat.accepts", () => {
  it.effect("decides a single instance when subsumption cannot", () =>
    Effect.gen(function* () {
      // Dropping an enum member is a narrowing, but config that never used
      // that member is unaffected. Only the instance can settle it.
      const narrowed = Schema.Struct({ state: Schema.Literal("CA", "NY") });

      expect(yield* SchemaCompat.accepts(narrowed, { state: "CA" })).toBe(true);
      expect(yield* SchemaCompat.accepts(narrowed, { state: "TX" })).toBe(
        false
      );
    })
  );
});
