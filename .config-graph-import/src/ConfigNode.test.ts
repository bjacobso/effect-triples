/**
 * Framework layer: merkle identity, dependency closure, and structural diff.
 *
 * The fixtures say "leaf" only because a kind has to be some string. No
 * assertion depends on what any of them mean; the file is about tree/leaf/dep
 * structure. Contrast `Releases.test.ts`, where the domain is the point.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as T from "./TypeExpr";

import * as CanonicalJson from "./CanonicalJson";
import * as ConfigNode from "./ConfigNode";
import * as ContentId from "./ContentId";

const leaf = (key: string, attrs: CanonicalJson.CanonicalValue = {}) =>
  ConfigNode.make({ kind: "leaf", key, attrs });

describe("ConfigNode identity", () => {
  it.effect("is stable across attribute key order and ref order", () =>
    Effect.gen(function* () {
      const first = yield* ConfigNode.make({
        kind: "leaf",
        key: "alpha",
        attrs: { type: "ssn", required: true },
        refs: [
          { rel: "uses_dep", kind: "dep", key: "alpha" },
          { rel: "uses_dep", kind: "dep", key: "beta" },
        ],
      });
      const second = yield* ConfigNode.make({
        kind: "leaf",
        key: "alpha",
        attrs: { required: true, type: "ssn" },
        refs: [
          { rel: "uses_dep", kind: "dep", key: "beta" },
          { rel: "uses_dep", kind: "dep", key: "alpha" },
          // A node can reach the same dependency by two routes; that is
          // options; that is one dependency, not two.
          { rel: "uses_dep", kind: "dep", key: "beta" },
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
          const field = yield* leaf("alpha", { label });
          const page = yield* ConfigNode.make({
            kind: "branch",
            key: "b1",
            children: [{ rel: "field", node: field }],
          });
          return yield* ConfigNode.make({
            kind: "tree",
            key: "root",
            children: [{ rel: "page", node: page }],
          });
        });

      const before = yield* build("A");
      const after = yield* build("B");

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
        kind: "branch",
        key: "p",
        children: [
          { rel: "field", node: a },
          { rel: "field", node: b },
        ],
      });
      const backward = yield* ConfigNode.make({
        kind: "branch",
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
        kind: "branch",
        key: "p",
        children: [
          { rel: "field", node: yield* leaf("alpha", { label: "a" }) },
          { rel: "field", node: yield* leaf("alpha", { label: "b" }) },
        ],
      }).pipe(Effect.flip);

      expect(error._tag).toEqual("DuplicateChildKeyError");
      expect(
        error._tag === "DuplicateChildKeyError" ? error.duplicate : undefined
      ).toEqual("field:alpha");
    })
  );
});

describe("ConfigNode.closureId", () => {
  it.effect("moves when a dependency changes but the node does not", () =>
    Effect.gen(function* () {
      const subject = yield* ConfigNode.make({
        kind: "tree",
        key: "root",
        refs: [{ rel: "uses_dep", kind: "dep", key: "alpha" }],
      });

      const withText = yield* ConfigNode.closureId(subject, [
        {
          kind: "dep",
          key: "alpha",
          cid: ContentId.hash("config-graph/node", "scalar:text"),
        },
      ]);
      const withNumber = yield* ConfigNode.closureId(subject, [
        {
          kind: "dep",
          key: "alpha",
          cid: ContentId.hash("config-graph/node", "scalar:number"),
        },
      ]);

      expect(subject.cid).toBeDefined();
      expect(withText).not.toEqual(withNumber);
    })
  );

  it.effect("is insensitive to dependency order and duplication", () =>
    Effect.gen(function* () {
      const subject = yield* ConfigNode.make({ kind: "tree", key: "root" });
      const dep = (key: string) => ({
        kind: "dep" as const,
        key,
        cid: ContentId.hash("config-graph/node", key),
      });

      const one = yield* ConfigNode.closureId(subject, [
        dep("alpha"),
        dep("beta"),
      ]);
      const two = yield* ConfigNode.closureId(subject, [
        dep("beta"),
        dep("alpha"),
        dep("beta"),
      ]);

      expect(one).toEqual(two);
    })
  );

  it.effect(
    "fails loudly when one dependency arrives with two content ids",
    () =>
      Effect.gen(function* () {
        const subject = yield* ConfigNode.make({ kind: "tree", key: "root" });
        const error = yield* ConfigNode.closureId(subject, [
          {
            kind: "dep",
            key: "alpha",
            cid: ContentId.hash("config-graph/node", "one"),
          },
          {
            kind: "dep",
            key: "alpha",
            cid: ContentId.hash("config-graph/node", "two"),
          },
        ]).pipe(Effect.flip);

        expect(error._tag).toEqual("ConflictingClosureEntryError");
      })
  );

  it.effect("terminates on a form <-> automation cycle", () =>
    Effect.gen(function* () {
      // The form owns an automation; the automation's action creates a task
      // from that same form. Refs are by key, so neither hash depends on the
      // other and both closures compute in one pass.
      const subject = yield* ConfigNode.make({
        kind: "tree",
        key: "root",
        refs: [{ rel: "owns", kind: "sink", key: "sink-1" }],
      });
      const sink = yield* ConfigNode.make({
        kind: "sink",
        key: "sink-1",
        refs: [{ rel: "points_at", kind: "tree", key: "root" }],
      });

      const subjectClosure = yield* ConfigNode.closureId(subject, [
        { kind: "sink", key: sink.key, cid: sink.cid },
      ]);
      const sinkClosure = yield* ConfigNode.closureId(sink, [
        { kind: "tree", key: subject.key, cid: subject.cid },
      ]);

      expect(subjectClosure).not.toEqual(sinkClosure);
    })
  );
});

describe("ConfigNode.diff", () => {
  const page = (key: string, fields: ReadonlyArray<ConfigNode.ConfigNode>) =>
    ConfigNode.make({
      kind: "branch",
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
        kind: "tree",
        key: "root",
        children: [
          { rel: "page", node: untouched },
          {
            rel: "page",
            node: yield* page("b1", [yield* leaf("ssn", { label: "A" })]),
          },
        ],
      });
      const after = yield* ConfigNode.make({
        kind: "tree",
        key: "root",
        children: [
          { rel: "page", node: untouched },
          {
            rel: "page",
            node: yield* page("b1", [yield* leaf("ssn", { label: "B" })]),
          },
        ],
      });

      const changes = ConfigNode.diff(before, after);

      expect(changes.map((change) => `${change._tag} ${change.path}`)).toEqual([
        "Changed root",
        "Changed root/page:b1",
        "Changed root/page:b1/field:ssn",
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
      // The same subtree reached by two relations is one row in the object
      // store, not two.
      const shared = yield* page("shared", [yield* leaf("a")]);
      const subject = yield* ConfigNode.make({
        kind: "tree",
        key: "root",
        children: [
          { rel: "page", node: shared },
          { rel: "review", node: shared },
        ],
      });

      const nodes = ConfigNode.flatten(subject);
      expect([...ConfigNode.walk(subject)]).toHaveLength(5);
      expect(nodes.size).toEqual(3);
    })
  );
});

describe("ConfigNode.makeTyped", () => {
  const FieldAttrs = T.struct({
    label: T.required(T.text),
    required: T.optional(T.boolean, true),
  });

  it.effect("normalises through the schema so equivalent configs collide", () =>
    Effect.gen(function* () {
      // One row spells the default out, the other leaves it off. Same form.
      const explicit = yield* ConfigNode.makeTyped({
        kind: "leaf",
        key: "alpha",
        type: FieldAttrs,
        attrs: { label: "A", required: true },
      });
      const implicit = yield* ConfigNode.makeTyped({
        kind: "leaf",
        key: "alpha",
        type: FieldAttrs,
        attrs: { label: "A" },
      });

      expect(explicit.cid).toEqual(implicit.cid);
      expect(explicit.attrs).toEqual({ label: "A", required: true });
    })
  );

  it.effect("rejects a projector that drifts from its declared shape", () =>
    Effect.gen(function* () {
      const error = yield* ConfigNode.makeTyped({
        kind: "leaf",
        key: "alpha",
        type: FieldAttrs,
        attrs: { label: 42 },
      }).pipe(Effect.flip);

      expect(error._tag).toEqual("SchemaError");
    })
  );

  it.effect("keeps the schema out of cid but inside stamp", () =>
    Effect.gen(function* () {
      // Adding an unused optional field to a projection changes no data. The
      // data id must hold still - otherwise every form in the account would
      // render as "changed" on the deploy screen - while the stamp records
      // that a different projector wrote it.
      const Widened = T.struct({
        label: T.required(T.text),
        required: T.optional(T.boolean, true),
        helpText: T.optional(T.text),
      });

      const before = yield* ConfigNode.makeTyped({
        kind: "leaf",
        key: "alpha",
        type: FieldAttrs,
        attrs: { label: "A" },
      });
      const after = yield* ConfigNode.makeTyped({
        kind: "leaf",
        key: "alpha",
        type: Widened,
        attrs: { label: "A" },
      });

      expect(after.cid).toEqual(before.cid);
      expect(ConfigNode.diff(before, after)).toEqual([]);

      expect(after.type && T.id(after.type)).not.toEqual(
        before.type && T.id(before.type)
      );
      expect(yield* ConfigNode.stamp(after)).not.toEqual(
        yield* ConfigNode.stamp(before)
      );
    })
  );

  it.effect("stamps untyped nodes distinctly from typed ones", () =>
    Effect.gen(function* () {
      const typed = yield* ConfigNode.makeTyped({
        kind: "leaf",
        key: "k",
        type: FieldAttrs,
        attrs: { label: "A", required: true },
      });
      const untyped = yield* ConfigNode.make({
        kind: "leaf",
        key: "k",
        attrs: { label: "A", required: true },
      });

      expect(typed.cid).toEqual(untyped.cid);
      expect(yield* ConfigNode.stamp(typed)).not.toEqual(
        yield* ConfigNode.stamp(untyped)
      );
    })
  );
});
