/**
 * The domain modeller's view: five releases of one account's configuration.
 *
 * Every question here is one a person who owns the I-9 form would actually ask.
 * Did my edit reach the things that depend on it? Somebody retyped an attribute
 * my form reads - does my form still behave the same? We shipped a code change
 * that touched no configuration; did it churn anything? I undid last week's
 * edit - is the form now what we shipped in 2026.1?
 *
 * The declaration this exercises lives in `domain/OnboardingConfig.ts`. What
 * remains here is the release story.
 *
 * NOTE (altitude): these assertions still reach for `cid`, `closureCid` and
 * `stamp`. That is a leak, and separating the file is what made it visible - a
 * form owner should never need to know what a SHA-256 is. The gap is a
 * domain-facing vocabulary (`unchanged` / `edited` / `affectedByDependency` /
 * `sameAsRelease`) sitting over the store, which does not exist yet.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as ConfigNode from "../../src/config/ConfigNode";
import * as InMemoryConfigStore from "../../src/config/InMemoryConfigStore";
import * as T from "../../src/config/TypeExpr";
import * as TypeSubsumption from "../../src/config/TypeSubsumption";
import {
  Attribute,
  BASELINE,
  changeFor,
  FieldAttrs,
  FieldAttrsV2,
  release,
} from "../../src/config/domain/OnboardingConfig";

describe("config graph end to end", () => {
  it.effect("versions five releases and keeps a verifiable history", () =>
    Effect.gen(function* () {
      let store = InMemoryConfigStore.empty();

      // -- Release 1: the baseline -------------------------------------------
      const r1 = yield* release(store, "2026.1", BASELINE);
      store = r1.store;

      // Six objects: three attributes, a form, a policy, an automation. Each
      // gets a first revision with no parent.
      expect(r1.created).toHaveLength(6);
      expect(r1.created.every((rev) => rev.parentId === null)).toBe(true);
      expect(r1.snapshot.parentId).toBeNull();

      // The cycle resolved. The form depends on the automation, the automation
      // depends on the form, and each closure enumerates the other exactly once.
      const formDeps = InMemoryConfigStore.tipOf(store, { kind: "form", key: "i9" })!;
      expect(formDeps.deps).toEqual([
        { kind: "attribute", key: "employee.ssn" },
        { kind: "attribute", key: "employee.start_date" },
        { kind: "attribute", key: "employee.work_state" },
        { kind: "automation", key: "i9-reverify" },
      ]);
      const autoDeps = InMemoryConfigStore.tipOf(store, {
        kind: "automation",
        key: "i9-reverify",
      })!;
      expect(autoDeps.deps.map((d) => `${d.kind}:${d.key}`)).toContain("form:i9");

      // -- Release 2: an edit propagates to everything downstream ------------
      const r2 = yield* release(store, "2026.2", {
        ...BASELINE,
        ssnLabel: "Social Security Number",
      });
      store = r2.store;

      const r1to2 = InMemoryConfigStore.changesBetween(store, r1.snapshot, r2.snapshot);

      // The form itself changed. The policy and the automation did not - but
      // both depend on the form, so both get a new revision recording that
      // their closure moved. Nobody edited them.
      const formChange = changeFor(r1to2, "form", "i9");
      expect(formChange?._tag).toEqual("ObjectChanged");
      expect(formChange?._tag === "ObjectChanged" && formChange.dataChanged).toBe(true);

      const policyChange = changeFor(r1to2, "policy", "new-hire");
      expect(policyChange?._tag === "ObjectChanged" && policyChange.dataChanged).toBe(false);
      expect(policyChange?._tag === "ObjectChanged" && policyChange.closureChanged).toBe(true);

      // The three attributes depend on nothing, so their revisions are reused
      // verbatim rather than rewritten.
      expect(r1to2.filter((c) => c.kind === "attribute")).toHaveLength(0);
      expect(r2.created.map((rev) => `${rev.kind}:${rev.key}`).sort()).toEqual([
        "automation:i9-reverify",
        "form:i9",
        "policy:new-hire",
      ]);

      // The merkle diff points at the one field that moved, not at the form.
      const nodeDiff = ConfigNode.diff(r1.snapshot.root, r2.snapshot.root);
      expect(
        nodeDiff.filter((change) => change.kind === "form.field").map((change) => change.path),
      ).toEqual(["config/form:i9/page:identity/field:employee.ssn"]);
      // The untouched page is not walked at all.
      expect(nodeDiff.some((change) => change.path.includes("page:employment"))).toBe(false);

      // -- Release 3: a dependency changes under an untouched form -----------
      const r3 = yield* release(store, "2026.3", {
        ...BASELINE,
        ssnLabel: "Social Security Number",
        workStates: ["CA", "NY", "TX", "WA"],
      });
      store = r3.store;

      const r2to3 = InMemoryConfigStore.changesBetween(store, r2.snapshot, r3.snapshot);

      // This is the case no per-object version number can express. The form's
      // own bytes are identical, so `cid` holds; the attribute it reads was
      // retyped, so its closure moved and it would behave differently.
      const drifted = changeFor(r2to3, "form", "i9");
      expect(drifted?._tag === "ObjectChanged" && drifted.dataChanged).toBe(false);
      expect(drifted?._tag === "ObjectChanged" && drifted.closureChanged).toBe(true);
      expect(drifted?._tag === "ObjectChanged" && drifted.from.cid === drifted.to.cid).toBe(true);

      // And the node diff agrees: the attribute moved, the form subtree did not.
      const r3NodeDiff = ConfigNode.diff(r2.snapshot.root, r3.snapshot.root);
      expect(
        r3NodeDiff.filter((change) => change.kind === "attribute").map((change) => change.path),
      ).toEqual(["config/attribute:employee.work_state"]);
      expect(r3NodeDiff.some((change) => change.path.includes("form:i9/"))).toBe(false);

      // -- Release 4: the code changes, the config does not ------------------
      const v1Type = T.id(FieldAttrs);
      const v2Type = T.id(FieldAttrsV2);

      const r4 = yield* release(store, "2026.4", {
        ...BASELINE,
        ssnLabel: "Social Security Number",
        workStates: ["CA", "NY", "TX", "WA"],
        fieldSchema: FieldAttrsV2,
      });
      store = r4.store;

      const r3to4 = InMemoryConfigStore.changesBetween(store, r3.snapshot, r4.snapshot);

      // A widened field schema. Every instance already stored still satisfies
      // it, and that is provable from the shapes alone without decoding a
      // single body - so this release is a genuine no-op. No revision is minted,
      // no object is reported as changed, and the snapshot lands on the id the
      // previous release already had.
      expect(TypeSubsumption.subsumes(FieldAttrs, FieldAttrsV2)._tag).toEqual("Widens");
      expect(r3to4).toEqual([]);
      expect(r4.created).toEqual([]);
      expect(r4.snapshot.rootCid).toEqual(r3.snapshot.rootCid);
      expect(r4.snapshot.id).not.toEqual(r3.snapshot.id);

      // What did change is what the store knows: each field body is now
      // recorded as satisfying both shapes, not just the one that wrote it.
      const ssnField = [...ConfigNode.walk(r4.snapshot.root)].find(
        ({ node }) => node.kind === "form.field" && node.key === "employee.ssn",
      )!.node;
      expect(InMemoryConfigStore.validityOf(store, ssnField.cid)).toEqual([v1Type, v2Type].sort());
      // The body release 3 wrote is the body release 4 read - the optional
      // property is absent, so it encodes away and the id never moved.
      expect(
        [...ConfigNode.walk(r3.snapshot.root)].some(({ node }) => node.cid === ssnField.cid),
      ).toBe(true);

      // Both shapes are in the append-only log, so an object written under the
      // old one can still be read back through it.
      expect(store.schemas.has(v1Type)).toBe(true);
      expect(store.schemas.has(v2Type)).toBe(true);
      // The log holds the type itself, not a serializer's rendering of it, so
      // an object written under the old shape can be read back through the
      // exact value that wrote it.
      expect(store.schemas.get(v1Type)).toEqual(FieldAttrs);

      // -- Release 5: reverting reproduces the original bytes ----------------
      const r5 = yield* release(store, "2026.5", {
        ...BASELINE,
        workStates: ["CA", "NY", "TX", "WA"],
        fieldSchema: FieldAttrsV2,
      });
      store = r5.store;

      const r1Form = r1.snapshot.revisionIds
        .map((id) => InMemoryConfigStore.revisionById(store, id))
        .find((rev) => rev?.kind === "form");
      const r5Form = InMemoryConfigStore.tipOf(store, { kind: "form", key: "i9" })!;

      // Undoing release 2's label edit lands on release 1's exact content id.
      // Content addressing answers "is this the same form we shipped in
      // 2026.1?" without diffing anything.
      expect(r1Form?.kind).toEqual("form");
      expect(r5Form.cid).toEqual(r1Form?.cid);
      // Same form bytes, but an attribute it reads has since gained an option,
      // so the closure still distinguishes them.
      expect(r5Form.closureCid).not.toEqual(r1Form?.closureCid);

      // -- The history reads as a chain --------------------------------------
      const history = InMemoryConfigStore.historyOf(store, { kind: "form", key: "i9" });
      // Newest first, and the head is what the tip resolves to.
      expect(history[0].id).toEqual(r5Form.id);
      expect(history.map((rev) => rev.seq)).toEqual(
        history.map((rev) => rev.seq).sort((a, b) => b - a),
      );
      // Each points at the one it superseded, ending at null.
      for (let i = 0; i < history.length - 1; i++) {
        expect(history[i].parentId).toEqual(history[i + 1].id);
      }
      expect(history[history.length - 1].parentId).toBeNull();
      // Four revisions across five releases. 2026.4 mints none: it changed the
      // projector, not the configuration, and the widening was provable.
      expect(history).toHaveLength(4);
      expect(
        history
          .slice()
          .reverse()
          .map((rev) =>
            rev.parentId === null
              ? "created"
              : [
                  rev.cid !== InMemoryConfigStore.revisionById(store, rev.parentId)!.cid
                    ? "data"
                    : null,
                  rev.closureCid !==
                  InMemoryConfigStore.revisionById(store, rev.parentId)!.closureCid
                    ? "closure"
                    : null,
                  rev.schemaCids.join() !==
                  InMemoryConfigStore.revisionById(store, rev.parentId)!.schemaCids.join()
                    ? "schema"
                    : null,
                ]
                  .filter(Boolean)
                  .join("+"),
          ),
      ).toEqual(["created", "data+closure", "closure", "data+closure+schema"]);

      // Snapshots chain the same way.
      expect(r5.snapshot.parentId).toEqual(r4.snapshot.id);
      expect(store.snapshots.map((snap) => snap.label)).toEqual([
        "2026.1",
        "2026.2",
        "2026.3",
        "2026.4",
        "2026.5",
      ]);

      // -- Deploying and rolling back is moving a pointer --------------------
      store = yield* InMemoryConfigStore.setRef(store, "live", r1.snapshot.id);
      store = yield* InMemoryConfigStore.setRef(store, "test", r5.snapshot.id);
      expect(InMemoryConfigStore.resolveRef(store, "live")?.label).toEqual("2026.1");

      store = yield* InMemoryConfigStore.setRef(store, "live", r5.snapshot.id);
      expect(InMemoryConfigStore.resolveRef(store, "live")?.rootCid).toEqual(r5.snapshot.rootCid);
      // Live and test now hold the identical graph - one string comparison,
      // no diff, which is the question "is test in sync with live" reduces to.
      expect(InMemoryConfigStore.resolveRef(store, "live")?.rootCid).toEqual(
        InMemoryConfigStore.resolveRef(store, "test")?.rootCid,
      );

      // Rollback is the same operation in the other direction, and it restores
      // an exact prior state rather than replaying edits.
      store = yield* InMemoryConfigStore.setRef(store, "live", r1.snapshot.id);
      expect(InMemoryConfigStore.resolveRef(store, "live")?.rootCid).toEqual(r1.snapshot.rootCid);

      // -- Storage is shared, not copied -------------------------------------
      // Five snapshots of a 12-node graph do not cost 60 rows: identical
      // subtrees across releases collapse onto one entry each.
      expect(store.objects.size).toBeLessThan(5 * [...ConfigNode.walk(r1.snapshot.root)].length);
      const ssn = yield* Attribute.node({
        attrs: {
          entityType: "employee",
          path: "ssn",
          label: "Social Security Number",
          scalarType: "text",
          sensitive: true,
        },
      });
      expect(store.objects.get(ssn.cid)?.kind).toEqual("attribute");
    }),
  );
});
