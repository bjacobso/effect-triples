import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as ConfigNode from "./ConfigNode";
import * as Entity from "./Entity";

const AttributeKind = Entity.kind("attribute");
const FieldKind = Entity.kind("form.field");
const PageKind = Entity.kind("form.page");

const FieldAttrs = Schema.Struct({
  path: Schema.String,
  label: Schema.String,
  required: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});

const PageAttrs = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
});

const Field = Entity.make({
  kind: FieldKind,
  attrs: FieldAttrs,
  key: (a) => a.path,
  refs: { uses_attribute: Entity.ref(AttributeKind) },
});

const Page = Entity.make({
  kind: PageKind,
  attrs: PageAttrs,
  key: (a) => a.slug,
  children: { field: Entity.children(FieldKind) },
});

describe("Entity", () => {
  it.effect("is exactly makeTyped underneath", () =>
    Effect.gen(function* () {
      // The declaration is sugar over the same call, so adopting it cannot move
      // a single id. Content addressing makes that a one-line proof.
      const viaEntity = yield* Field.node({
        attrs: { path: "employee.ssn", label: "SSN" },
        refs: { uses_attribute: [AttributeKind.key("employee.ssn")] },
      });

      const viaMakeTyped = yield* ConfigNode.makeTyped({
        kind: "form.field",
        key: "employee.ssn",
        schema: FieldAttrs,
        attrs: { path: "employee.ssn", label: "SSN" },
        refs: [
          {
            rel: "uses_attribute",
            kind: "attribute",
            key: "employee.ssn",
          },
        ],
      });

      expect(viaEntity.cid).toEqual(viaMakeTyped.cid);
      expect(viaEntity.schema?.cid).toEqual(viaMakeTyped.schema?.cid);
    })
  );

  it.effect("derives the node key from the data", () =>
    Effect.gen(function* () {
      // One home for the "semantic, never a row id" rule, rather than a `key`
      // argument every call site supplies by hand.
      const page = yield* Page.node({
        attrs: { slug: "identity", title: "Identity" },
      });
      expect(page.key).toEqual("identity");
      expect(Page.keyOf({ slug: "identity", title: "Identity" })).toEqual(
        "identity"
      );
    })
  );

  it.effect("orders children by declaration, not by caller input", () =>
    Effect.gen(function* () {
      // Child order is content, so it must come from the projector rather than
      // from however a caller happened to spell an object literal.
      const a = yield* Field.node({ attrs: { path: "a", label: "A" } });
      const b = yield* Field.node({ attrs: { path: "b", label: "B" } });

      const page = yield* Page.node({
        attrs: { slug: "p", title: "P" },
        children: { field: [a, b] },
      });

      expect(page.children.map((child) => child.rel)).toEqual([
        "field",
        "field",
      ]);
      expect(page.children.map((child) => child.node.key)).toEqual(["a", "b"]);
    })
  );

  it.effect("keeps the id still when only the schema widens", () =>
    Effect.gen(function* () {
      // Running the same entity under a new shape is what a projector deploy
      // is; `withSchema` says so without cloning the entity.
      const Widened = Schema.Struct({
        ...FieldAttrs.fields,
        helpText: Schema.optional(Schema.String),
      });
      const FieldV2 = Entity.withSchema(Field, Widened);

      const before = yield* Field.node({
        attrs: { path: "employee.ssn", label: "SSN" },
      });
      const after = yield* FieldV2.node({
        attrs: { path: "employee.ssn", label: "SSN" },
      });

      expect(after.cid).toEqual(before.cid);
      expect(after.schema?.cid).not.toEqual(before.schema?.cid);
      expect(FieldV2.kind.name).toEqual("form.field");
    })
  );

  it.effect("rejects two children sharing a key, via the entity too", () =>
    Effect.gen(function* () {
      const first = yield* Field.node({ attrs: { path: "dup", label: "A" } });
      const second = yield* Field.node({ attrs: { path: "dup", label: "B" } });

      const error = yield* Page.node({
        attrs: { slug: "p", title: "P" },
        children: { field: [first, second] },
      }).pipe(Effect.flip);

      expect(error._tag).toEqual("DuplicateChildKeyError");
    })
  );
});

describe("Entity type safety", () => {
  // These never run. They exist so `tsc` fails if the branding stops working -
  // each mistake below produced a perfectly valid hash under the old
  // stringly-typed projectors and only surfaced at commit time, if at all.
  it("rejects the mistakes the old projectors accepted", () => {
    const FormKind = Entity.kind("form");

    const buildWithWrongKeyKind = () =>
      Field.node({
        attrs: { path: "employee.ssn", label: "SSN" },
        // @ts-expect-error a form key cannot address an attribute
        refs: { uses_attribute: [FormKind.key("i9")] },
      });

    const buildWithRawString = () =>
      Field.node({
        attrs: { path: "employee.ssn", label: "SSN" },
        // @ts-expect-error an unbranded string is not an attribute key
        refs: { uses_attribute: ["employee.ssn"] },
      });

    const buildWithUndeclaredRelation = () =>
      Field.node({
        attrs: { path: "employee.ssn", label: "SSN" },
        // @ts-expect-error `scopes` is not a relation this entity declares
        refs: { scopes: [AttributeKind.key("employee.ssn")] },
      });

    const buildWithWrongAttrs = () =>
      // @ts-expect-error `title` is not part of the field shape
      Field.node({ attrs: { path: "p", title: "SSN" } });

    expect([
      buildWithWrongKeyKind,
      buildWithRawString,
      buildWithUndeclaredRelation,
      buildWithWrongAttrs,
    ]).toHaveLength(4);
  });

  it.effect("rejects nesting a node of the wrong kind", () =>
    Effect.gen(function* () {
      const page = yield* Page.node({ attrs: { slug: "p", title: "P" } });

      const buildPageInsidePage = () =>
        Page.node({
          attrs: { slug: "outer", title: "Outer" },
          // @ts-expect-error a page is not a field
          children: { field: [page] },
        });

      expect(buildPageInsidePage).toBeTypeOf("function");
    })
  );
});
