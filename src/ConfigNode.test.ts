import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as CanonicalJson from "./CanonicalJson";
import * as ConfigNode from "./ConfigNode";
import * as ContentId from "./ContentId";
import * as SchemaId from "./SchemaId";

const leaf = (key: string, attrs: CanonicalJson.CanonicalValue = {}) =>
  ConfigNode.make({ kind: "form.field", key, attrs });

describe("CanonicalJson", () => {
  it.effect("is insensitive to object key order at any depth", () =>
    Effect.gen(function* () {
      const a = yield* CanonicalJson.encode({
        b: { y: 1, x: [{ q: true, p: null }] },
        a: "z",
      });
      const b = yield* CanonicalJson.encode({
        a: "z",
        b: { x: [{ p: null, q: true }], y: 1 },
      });
      expect(a).toEqual(b);
      expect(a).toEqual('{"a":"z","b":{"x":[{"p":null,"q":true}],"y":1}}');
    })
  );

  it.effect("drops undefined properties but keeps undefined array slots", () =>
    Effect.gen(function* () {
      expect(yield* CanonicalJson.encode({ a: 1, b: undefined })).toEqual(
        yield* CanonicalJson.encode({ a: 1 })
      );
      expect(yield* CanonicalJson.encode([1, undefined, 2])).toEqual(
        "[1,null,2]"
      );
    })
  );

  it.effect("normalises -0 so it shares a hash with 0", () =>
    Effect.gen(function* () {
      expect(yield* CanonicalJson.encode({ n: -0 })).toEqual('{"n":0}');
    })
  );

  it.effect("rejects values with no stable encoding", () =>
    Effect.gen(function* () {
      const reasons = yield* Effect.all(
        [
          { deep: { bad: Number.NaN } },
          { at: new Date(0) },
          { fn: (() => 1) as never },
        ].map((value) =>
          CanonicalJson.encode(value as CanonicalJson.CanonicalValue).pipe(
            Effect.flip,
            Effect.map((error) => `${error.reason} @ ${error.path}`)
          )
        )
      );

      expect(reasons).toEqual([
        "non_finite_number @ deep.bad",
        "unsupported_type @ at",
        "unsupported_type @ fn",
      ]);
    })
  );

  it.effect("rejects cycles rather than looping forever", () =>
    Effect.gen(function* () {
      const cyclic: Record<string, unknown> = { name: "a" };
      cyclic.self = cyclic;

      const error = yield* CanonicalJson.encode(
        cyclic as CanonicalJson.CanonicalValue
      ).pipe(Effect.flip);

      expect(error.reason).toEqual("circular_reference");
      expect(error.path).toEqual("self");
    })
  );
});

describe("ContentId", () => {
  it("renders a self-describing, algorithm-tagged id", () => {
    expect(ContentId.hash("test", "payload")).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(ContentId.isContentId(ContentId.hash("test", "payload"))).toBe(true);
  });

  it("separates domains so a node id cannot be forged from a blob id", () => {
    expect(ContentId.hash("a", "x")).not.toEqual(ContentId.hash("b", "x"));
    // The length prefix stops the domain and payload from being reflowed into
    // each other: hash("ab", "c") must not equal hash("a", "bc").
    expect(ContentId.hash("ab", "c")).not.toEqual(ContentId.hash("a", "bc"));
  });
});

describe("ConfigNode identity", () => {
  it.effect("is stable across attribute key order and ref order", () =>
    Effect.gen(function* () {
      const first = yield* ConfigNode.make({
        kind: "form.field",
        key: "employee.ssn",
        attrs: { type: "ssn", required: true },
        refs: [
          { rel: "uses_attribute", kind: "attribute", key: "employee.ssn" },
          { rel: "uses_attribute", kind: "attribute", key: "employee.dob" },
        ],
      });
      const second = yield* ConfigNode.make({
        kind: "form.field",
        key: "employee.ssn",
        attrs: { required: true, type: "ssn" },
        refs: [
          { rel: "uses_attribute", kind: "attribute", key: "employee.dob" },
          { rel: "uses_attribute", kind: "attribute", key: "employee.ssn" },
          // A field can reach the same attribute from its rule and its
          // options; that is one dependency, not two.
          { rel: "uses_attribute", kind: "attribute", key: "employee.dob" },
        ],
      });

      expect(first.cid).toEqual(second.cid);
      expect(second.refs).toHaveLength(2);
    })
  );

  it.effect("bubbles a leaf change all the way to the root", () =>
    Effect.gen(function* () {
      const build = (label: string) =>
        Effect.gen(function* () {
          const field = yield* leaf("employee.ssn", { label });
          const page = yield* ConfigNode.make({
            kind: "form.page",
            key: "personal-info",
            children: [{ rel: "field", node: field }],
          });
          return yield* ConfigNode.make({
            kind: "form",
            key: "i9",
            children: [{ rel: "page", node: page }],
          });
        });

      const before = yield* build("SSN");
      const after = yield* build("Social Security Number");

      expect(before.cid).not.toEqual(after.cid);
      expect(before.children[0].node.cid).not.toEqual(
        after.children[0].node.cid
      );
    })
  );

  it.effect("changes when children are reordered", () =>
    Effect.gen(function* () {
      const a = yield* leaf("a");
      const b = yield* leaf("b");
      const forward = yield* ConfigNode.make({
        kind: "form.page",
        key: "p",
        children: [
          { rel: "field", node: a },
          { rel: "field", node: b },
        ],
      });
      const backward = yield* ConfigNode.make({
        kind: "form.page",
        key: "p",
        children: [
          { rel: "field", node: b },
          { rel: "field", node: a },
        ],
      });

      expect(forward.cid).not.toEqual(backward.cid);
    })
  );

  it.effect("rejects two children sharing a key in one relation", () =>
    Effect.gen(function* () {
      const error = yield* ConfigNode.make({
        kind: "form.page",
        key: "p",
        children: [
          { rel: "field", node: yield* leaf("employee.ssn", { label: "a" }) },
          { rel: "field", node: yield* leaf("employee.ssn", { label: "b" }) },
        ],
      }).pipe(Effect.flip);

      expect(error._tag).toEqual("DuplicateChildKeyError");
      expect(
        error._tag === "DuplicateChildKeyError" ? error.duplicate : undefined
      ).toEqual("field:employee.ssn");
    })
  );
});

describe("ConfigNode.closureId", () => {
  it.effect("moves when a dependency changes but the node does not", () =>
    Effect.gen(function* () {
      const form = yield* ConfigNode.make({
        kind: "form",
        key: "i9",
        refs: [
          { rel: "uses_attribute", kind: "attribute", key: "employee.ssn" },
        ],
      });

      const withText = yield* ConfigNode.closureId(form, [
        {
          kind: "attribute",
          key: "employee.ssn",
          cid: ContentId.hash("config-graph/node", "scalar:text"),
        },
      ]);
      const withNumber = yield* ConfigNode.closureId(form, [
        {
          kind: "attribute",
          key: "employee.ssn",
          cid: ContentId.hash("config-graph/node", "scalar:number"),
        },
      ]);

      expect(form.cid).toBeDefined();
      expect(withText).not.toEqual(withNumber);
    })
  );

  it.effect("is insensitive to dependency order and duplication", () =>
    Effect.gen(function* () {
      const form = yield* ConfigNode.make({ kind: "form", key: "i9" });
      const dep = (key: string) => ({
        kind: "attribute" as const,
        key,
        cid: ContentId.hash("config-graph/node", key),
      });

      const one = yield* ConfigNode.closureId(form, [
        dep("employee.ssn"),
        dep("employee.dob"),
      ]);
      const two = yield* ConfigNode.closureId(form, [
        dep("employee.dob"),
        dep("employee.ssn"),
        dep("employee.dob"),
      ]);

      expect(one).toEqual(two);
    })
  );

  it.effect(
    "fails loudly when one dependency arrives with two content ids",
    () =>
      Effect.gen(function* () {
        const form = yield* ConfigNode.make({ kind: "form", key: "i9" });
        const error = yield* ConfigNode.closureId(form, [
          {
            kind: "attribute",
            key: "employee.ssn",
            cid: ContentId.hash("config-graph/node", "one"),
          },
          {
            kind: "attribute",
            key: "employee.ssn",
            cid: ContentId.hash("config-graph/node", "two"),
          },
        ]).pipe(Effect.flip);

        expect(error._tag).toEqual("ConflictingClosureEntryError");
      })
  );

  it.effect("terminates on a form <-> automation cycle", () =>
    Effect.gen(function* () {
      // The form scopes an automation; the automation's action creates a task
      // from that same form. Refs are by key, so neither hash depends on the
      // other and both closures compute in one pass.
      const form = yield* ConfigNode.make({
        kind: "form",
        key: "i9",
        refs: [{ rel: "scopes", kind: "automation", key: "i9-reverify" }],
      });
      const automation = yield* ConfigNode.make({
        kind: "automation",
        key: "i9-reverify",
        refs: [{ rel: "creates_task", kind: "form", key: "i9" }],
      });

      const formClosure = yield* ConfigNode.closureId(form, [
        { kind: "automation", key: automation.key, cid: automation.cid },
      ]);
      const automationClosure = yield* ConfigNode.closureId(automation, [
        { kind: "form", key: form.key, cid: form.cid },
      ]);

      expect(formClosure).not.toEqual(automationClosure);
    })
  );
});

describe("ConfigNode.diff", () => {
  const page = (key: string, fields: ReadonlyArray<ConfigNode.ConfigNode>) =>
    ConfigNode.make({
      kind: "form.page",
      key,
      children: fields.map((node) => ({ rel: "field", node })),
    });

  it.effect("reports only the path that changed", () =>
    Effect.gen(function* () {
      const untouched = yield* page("untouched", [
        yield* leaf("a"),
        yield* leaf("b"),
      ]);

      const before = yield* ConfigNode.make({
        kind: "form",
        key: "i9",
        children: [
          { rel: "page", node: untouched },
          {
            rel: "page",
            node: yield* page("personal", [
              yield* leaf("ssn", { label: "SSN" }),
            ]),
          },
        ],
      });
      const after = yield* ConfigNode.make({
        kind: "form",
        key: "i9",
        children: [
          { rel: "page", node: untouched },
          {
            rel: "page",
            node: yield* page("personal", [
              yield* leaf("ssn", { label: "Social Security Number" }),
            ]),
          },
        ],
      });

      const changes = ConfigNode.diff(before, after);

      expect(changes.map((change) => `${change._tag} ${change.path}`)).toEqual([
        "Changed i9",
        "Changed i9/page:personal",
        "Changed i9/page:personal/field:ssn",
      ]);
      const field = changes[2];
      expect(field._tag === "Changed" && field.attrsChanged).toBe(true);
    })
  );

  it.effect("distinguishes add, remove and reorder", () =>
    Effect.gen(function* () {
      const a = yield* leaf("a");
      const b = yield* leaf("b");
      const c = yield* leaf("c");

      const changes = ConfigNode.diff(
        yield* page("p", [a, b]),
        yield* page("p", [c, b])
      );

      expect(changes.map((change) => `${change._tag} ${change.path}`)).toEqual([
        "Changed p",
        "Added p/field:c",
        "Removed p/field:a",
      ]);

      const reorder = ConfigNode.diff(
        yield* page("p", [a, b]),
        yield* page("p", [b, a])
      );
      expect(reorder).toHaveLength(1);
      expect(reorder[0]._tag === "Changed" && reorder[0].reordered).toBe(true);
    })
  );

  it.effect("returns nothing for an identical subtree", () =>
    Effect.gen(function* () {
      const built = yield* page("p", [yield* leaf("a")]);
      const rebuilt = yield* page("p", [yield* leaf("a")]);
      expect(ConfigNode.diff(built, rebuilt)).toEqual([]);
    })
  );

  it.effect("stores structurally identical subtrees once", () =>
    Effect.gen(function* () {
      // The same page reused by two forms - or one form present in both live
      // and test mode - is one row in the object store, not two.
      const shared = yield* page("shared", [yield* leaf("a")]);
      const form = yield* ConfigNode.make({
        kind: "form",
        key: "i9",
        children: [
          { rel: "page", node: shared },
          { rel: "review", node: shared },
        ],
      });

      const nodes = ConfigNode.flatten(form);
      expect([...ConfigNode.walk(form)]).toHaveLength(5);
      expect(nodes.size).toEqual(3);
    })
  );
});

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

describe("ConfigNode.makeTyped", () => {
  const FieldAttrs = Schema.Struct({
    label: Schema.String,
    required: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  });

  it.effect("normalises through the schema so equivalent configs collide", () =>
    Effect.gen(function* () {
      // One row spells the default out, the other leaves it off. Same form.
      const explicit = yield* ConfigNode.makeTyped({
        kind: "form.field",
        key: "employee.ssn",
        schema: FieldAttrs,
        attrs: { label: "SSN", required: true },
      });
      const implicit = yield* ConfigNode.makeTyped({
        kind: "form.field",
        key: "employee.ssn",
        schema: FieldAttrs,
        attrs: { label: "SSN" },
      });

      expect(explicit.cid).toEqual(implicit.cid);
      expect(explicit.attrs).toEqual({ label: "SSN", required: true });
    })
  );

  it.effect("rejects a projector that drifts from its declared shape", () =>
    Effect.gen(function* () {
      const error = yield* ConfigNode.makeTyped({
        kind: "form.field",
        key: "employee.ssn",
        schema: FieldAttrs,
        attrs: { label: 42 },
      }).pipe(Effect.flip);

      expect(error._tag).toEqual("ParseError");
    })
  );

  it.effect("keeps the schema out of cid but inside stamp", () =>
    Effect.gen(function* () {
      // Adding an unused optional field to a projection changes no data. The
      // data id must hold still - otherwise every form in the account would
      // render as "changed" on the deploy screen - while the stamp records
      // that a different projector wrote it.
      const Widened = Schema.Struct({
        ...FieldAttrs.fields,
        helpText: Schema.optional(Schema.String),
      });

      const before = yield* ConfigNode.makeTyped({
        kind: "form.field",
        key: "employee.ssn",
        schema: FieldAttrs,
        attrs: { label: "SSN" },
      });
      const after = yield* ConfigNode.makeTyped({
        kind: "form.field",
        key: "employee.ssn",
        schema: Widened,
        attrs: { label: "SSN" },
      });

      expect(after.cid).toEqual(before.cid);
      expect(ConfigNode.diff(before, after)).toEqual([]);

      expect(after.schema?.cid).not.toEqual(before.schema?.cid);
      expect(yield* ConfigNode.stamp(after)).not.toEqual(
        yield* ConfigNode.stamp(before)
      );
    })
  );

  it.effect("stamps untyped nodes distinctly from typed ones", () =>
    Effect.gen(function* () {
      const typed = yield* ConfigNode.makeTyped({
        kind: "form.field",
        key: "k",
        schema: FieldAttrs,
        attrs: { label: "SSN", required: true },
      });
      const untyped = yield* ConfigNode.make({
        kind: "form.field",
        key: "k",
        attrs: { label: "SSN", required: true },
      });

      expect(typed.cid).toEqual(untyped.cid);
      expect(yield* ConfigNode.stamp(typed)).not.toEqual(
        yield* ConfigNode.stamp(untyped)
      );
    })
  );
});
