/**
 * End-to-end scenario: a realistic account configuration walked through five
 * releases, versioned as one graph, with its history verified at each step.
 *
 * No database and no browser - "end to end" here means every layer of this
 * package at once: Effect Schemas define the shapes, projectors turn them into
 * merkle nodes, the store records revisions and snapshots, and refs deploy and
 * roll back. It is meant to be read top to bottom as the argument for the
 * design, so each release is named for the question it answers.
 *
 * The config is small but has the shape of the real thing, including the cycle:
 * form `i9` scopes automation `i9-reverify`, and that automation's action
 * creates a task from form `i9`.
 *
 *   attribute employee.ssn ─┐
 *   attribute employee.start_date ─┼──< form i9 >──┬── policy new-hire
 *   attribute employee.work_state ─┘       ▲       │
 *                                          └───────┴── automation i9-reverify
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as ConfigNode from "./ConfigNode";
import * as ConfigStore from "./ConfigStore";
import * as Entity from "./Entity";
import * as SchemaCompat from "./SchemaCompat";
import * as SchemaId from "./SchemaId";

// ---------------------------------------------------------------------------
// The graph of schemas. One per node kind; this is the whole type system the
// config is allowed to express, and each shape content-addresses itself.
// ---------------------------------------------------------------------------

const AttributeAttrs = Schema.Struct({
  entityType: Schema.Literal("employee", "employer"),
  path: Schema.String,
  label: Schema.String,
  scalarType: Schema.Literal("text", "date", "enum", "number"),
  enumOptions: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  sensitive: Schema.optionalWith(Schema.Boolean, { default: () => false }),
});

const FieldAttrs = Schema.Struct({
  path: Schema.String,
  type: Schema.Literal("text", "date", "select", "ssn"),
  label: Schema.String,
  required: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});

/** Release 4 widens this shape without touching any data. */
const FieldAttrsV2 = Schema.Struct({
  ...FieldAttrs.fields,
  helpText: Schema.optional(Schema.String),
});

const PageAttrs = Schema.Struct({
  // The semantic key lives in the data rather than arriving as a separate
  // argument, which is what declaring `key` on the entity forces.
  slug: Schema.String,
  title: Schema.String,
  assignee: Schema.Literal("employee", "employer"),
});

const FormAttrs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
});

const PolicyAttrs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  status: Schema.Literal("enabled", "disabled"),
});

const AutomationAttrs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  triggerEntity: Schema.Literal("task", "placement", "employee"),
});

const ActionAttrs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  actionType: Schema.Literal("create_task", "send_email"),
});

// ---------------------------------------------------------------------------
// The entities. Each declares its kind once, derives its own key, and names its
// relations - `children` for what nests and hashes into it, `ref` for what it
// merely depends on. Targets are thunks because the graph genuinely cycles.
// ---------------------------------------------------------------------------

const AttributeKind = Entity.kind("attribute");
const FormKind = Entity.kind("form");
const PageKind = Entity.kind("form.page");
const FieldKind = Entity.kind("form.field");
const PolicyKind = Entity.kind("policy");
const AutomationKind = Entity.kind("automation");
const ActionKind = Entity.kind("automation.action");

const Attribute = Entity.make({
  kind: AttributeKind,
  attrs: AttributeAttrs,
  key: (a) => `${a.entityType}.${a.path}`,
});

const FormField = Entity.make({
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

const Form = Entity.make({
  kind: FormKind,
  attrs: FormAttrs,
  key: (a) => a.slug,
  children: { page: Entity.children(PageKind) },
  refs: { scopes: Entity.ref(AutomationKind) },
});

const Policy = Entity.make({
  kind: PolicyKind,
  attrs: PolicyAttrs,
  key: (a) => a.slug,
  refs: { distributes: Entity.ref(FormKind) },
});

const Action = Entity.make({
  kind: ActionKind,
  attrs: ActionAttrs,
  key: (a) => a.slug,
  refs: { creates_task: Entity.ref(FormKind) },
});

const Automation = Entity.make({
  kind: AutomationKind,
  attrs: AutomationAttrs,
  key: (a) => a.slug,
  children: { action: Entity.children(ActionKind) },
  refs: { uses_attribute: Entity.ref(AttributeKind) },
});

// ---------------------------------------------------------------------------
// The account's configuration, parameterised by the things releases change.
// ---------------------------------------------------------------------------

interface AccountConfig {
  readonly ssnLabel: string;
  readonly workStates: ReadonlyArray<string>;
  readonly fieldSchema: Schema.Schema.AnyNoContext;
}

const BASELINE: AccountConfig = {
  ssnLabel: "SSN",
  workStates: ["CA", "NY", "TX"],
  fieldSchema: FieldAttrs,
};

const buildAccount = (config: AccountConfig) =>
  Effect.gen(function* () {
    // A widened field shape is the same entity read under a new schema, not a
    // different entity.
    const FieldOf = Entity.withSchema(FormField, config.fieldSchema);

    const attributes = yield* Effect.all([
      Attribute.node({
        attrs: {
          entityType: "employee",
          path: "ssn",
          label: "Social Security Number",
          scalarType: "text",
          sensitive: true,
        },
      }),
      Attribute.node({
        attrs: {
          entityType: "employee",
          path: "start_date",
          label: "Start date",
          scalarType: "date",
        },
      }),
      Attribute.node({
        attrs: {
          entityType: "employee",
          path: "work_state",
          label: "Work state",
          scalarType: "enum",
          enumOptions: config.workStates,
        },
      }),
    ]);

    // Ref keys are branded, so `Attribute.key(...)` is the only way to name an
    // attribute here - a form key would not compile.
    const i9 = yield* Form.node({
      attrs: {
        slug: "i9",
        name: "Form I-9",
        description: "Employment eligibility verification",
      },
      children: {
        page: [
          yield* Page.node({
            attrs: {
              slug: "identity",
              title: "Identity",
              assignee: "employee",
            },
            children: {
              field: [
                yield* FieldOf.node({
                  attrs: {
                    path: "employee.ssn",
                    type: "ssn",
                    label: config.ssnLabel,
                    required: true,
                  },
                  refs: {
                    uses_attribute: [Attribute.key("employee.ssn")],
                  },
                }),
              ],
            },
          }),
          yield* Page.node({
            attrs: {
              slug: "employment",
              title: "Employment",
              assignee: "employee",
            },
            children: {
              field: [
                yield* FieldOf.node({
                  attrs: {
                    path: "employee.start_date",
                    type: "date",
                    label: "Start date",
                  },
                  refs: {
                    uses_attribute: [Attribute.key("employee.start_date")],
                  },
                }),
                yield* FieldOf.node({
                  attrs: {
                    path: "employee.work_state",
                    type: "select",
                    label: "Work state",
                  },
                  refs: {
                    uses_attribute: [Attribute.key("employee.work_state")],
                  },
                }),
              ],
            },
          }),
        ],
      },
      // The form scopes its own re-verification automation, whose action
      // creates a task from this same form. The thunk targets in the entity
      // declarations are what let that cycle be written down.
      refs: { scopes: [Automation.key("i9-reverify")] },
    });

    const newHire = yield* Policy.node({
      attrs: {
        slug: "new-hire",
        name: "New hire onboarding",
        status: "enabled",
      },
      refs: { distributes: [Form.key("i9")] },
    });

    const reverify = yield* Automation.node({
      attrs: {
        slug: "i9-reverify",
        name: "I-9 reverification",
        triggerEntity: "placement",
      },
      children: {
        action: [
          yield* Action.node({
            attrs: {
              slug: "create-i9",
              name: "Create I-9",
              actionType: "create_task",
            },
            refs: { creates_task: [Form.key("i9")] },
          }),
        ],
      },
      refs: { uses_attribute: [Attribute.key("employee.start_date")] },
    });

    return [...attributes, i9, newHire, reverify];
  });

const release = (
  store: ConfigStore.ConfigStore,
  label: string,
  config: AccountConfig
) =>
  Effect.gen(function* () {
    const objects = yield* buildAccount(config);
    return yield* ConfigStore.commit(store, { label, objects });
  });

const changeFor = (
  changes: ReadonlyArray<ConfigStore.ObjectChange>,
  kind: string,
  key: string
) => changes.find((c) => c.kind === kind && c.key === key);

// ---------------------------------------------------------------------------

describe("config graph end to end", () => {
  it.effect("versions five releases and keeps a verifiable history", () =>
    Effect.gen(function* () {
      let store = ConfigStore.empty();

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
      const formDeps = ConfigStore.tipOf(store, { kind: "form", key: "i9" })!;
      expect(formDeps.deps).toEqual([
        { kind: "attribute", key: "employee.ssn" },
        { kind: "attribute", key: "employee.start_date" },
        { kind: "attribute", key: "employee.work_state" },
        { kind: "automation", key: "i9-reverify" },
      ]);
      const autoDeps = ConfigStore.tipOf(store, {
        kind: "automation",
        key: "i9-reverify",
      })!;
      expect(autoDeps.deps.map((d) => `${d.kind}:${d.key}`)).toContain(
        "form:i9"
      );

      // -- Release 2: an edit propagates to everything downstream ------------
      const r2 = yield* release(store, "2026.2", {
        ...BASELINE,
        ssnLabel: "Social Security Number",
      });
      store = r2.store;

      const r1to2 = ConfigStore.changesBetween(store, r1.snapshot, r2.snapshot);

      // The form itself changed. The policy and the automation did not - but
      // both depend on the form, so both get a new revision recording that
      // their closure moved. Nobody edited them.
      const formChange = changeFor(r1to2, "form", "i9");
      expect(formChange?._tag).toEqual("ObjectChanged");
      expect(
        formChange?._tag === "ObjectChanged" && formChange.dataChanged
      ).toBe(true);

      const policyChange = changeFor(r1to2, "policy", "new-hire");
      expect(
        policyChange?._tag === "ObjectChanged" && policyChange.dataChanged
      ).toBe(false);
      expect(
        policyChange?._tag === "ObjectChanged" && policyChange.closureChanged
      ).toBe(true);

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
        nodeDiff
          .filter((change) => change.kind === "form.field")
          .map((change) => change.path)
      ).toEqual(["config/form:i9/page:identity/field:employee.ssn"]);
      // The untouched page is not walked at all.
      expect(
        nodeDiff.some((change) => change.path.includes("page:employment"))
      ).toBe(false);

      // -- Release 3: a dependency changes under an untouched form -----------
      const r3 = yield* release(store, "2026.3", {
        ...BASELINE,
        ssnLabel: "Social Security Number",
        workStates: ["CA", "NY", "TX", "WA"],
      });
      store = r3.store;

      const r2to3 = ConfigStore.changesBetween(store, r2.snapshot, r3.snapshot);

      // This is the case no per-object version number can express. The form's
      // own bytes are identical, so `cid` holds; the attribute it reads was
      // retyped, so its closure moved and it would behave differently.
      const drifted = changeFor(r2to3, "form", "i9");
      expect(drifted?._tag === "ObjectChanged" && drifted.dataChanged).toBe(
        false
      );
      expect(drifted?._tag === "ObjectChanged" && drifted.closureChanged).toBe(
        true
      );
      expect(
        drifted?._tag === "ObjectChanged" && drifted.from.cid === drifted.to.cid
      ).toBe(true);

      // And the node diff agrees: the attribute moved, the form subtree did not.
      const r3NodeDiff = ConfigNode.diff(r2.snapshot.root, r3.snapshot.root);
      expect(
        r3NodeDiff
          .filter((change) => change.kind === "attribute")
          .map((change) => change.path)
      ).toEqual(["config/attribute:employee.work_state"]);
      expect(
        r3NodeDiff.some((change) => change.path.includes("form:i9/"))
      ).toBe(false);

      // -- Release 4: the code changes, the config does not ------------------
      const v1Schema = yield* SchemaId.of(FieldAttrs);
      const v2Schema = yield* SchemaId.of(FieldAttrsV2);

      const r4 = yield* release(store, "2026.4", {
        ...BASELINE,
        ssnLabel: "Social Security Number",
        workStates: ["CA", "NY", "TX", "WA"],
        fieldSchema: FieldAttrsV2,
      });
      store = r4.store;

      const r3to4 = ConfigStore.changesBetween(store, r3.snapshot, r4.snapshot);

      // A widened field schema. Every instance already stored still satisfies
      // it, and that is provable from the shapes alone without decoding a
      // single body - so this release is a genuine no-op. No revision is minted,
      // no object is reported as changed, and the snapshot lands on the id the
      // previous release already had.
      expect(SchemaCompat.subsumes(v1Schema, v2Schema)._tag).toEqual("Widens");
      expect(r3to4).toEqual([]);
      expect(r4.created).toEqual([]);
      expect(r4.snapshot.rootCid).toEqual(r3.snapshot.rootCid);
      expect(r4.snapshot.id).not.toEqual(r3.snapshot.id);

      // What did change is what the store knows: each field body is now
      // recorded as satisfying both shapes, not just the one that wrote it.
      const ssnField = [...ConfigNode.walk(r4.snapshot.root)].find(
        ({ node }) => node.kind === "form.field" && node.key === "employee.ssn"
      )!.node;
      expect(ConfigStore.validityOf(store, ssnField.cid)).toEqual(
        [v1Schema.cid, v2Schema.cid].sort()
      );
      // The body release 3 wrote is the body release 4 read - the optional
      // property is absent, so it encodes away and the id never moved.
      expect(
        [...ConfigNode.walk(r3.snapshot.root)].some(
          ({ node }) => node.cid === ssnField.cid
        )
      ).toBe(true);

      // Both shapes are in the append-only log, so an object written under the
      // old one can still be read back through it.
      expect(store.schemas.has(v1Schema.cid)).toBe(true);
      expect(store.schemas.has(v2Schema.cid)).toBe(true);
      expect(store.schemas.get(v1Schema.cid)?.jsonSchema).toMatchObject({
        properties: { label: { type: "string" } },
      });

      // -- Release 5: reverting reproduces the original bytes ----------------
      const r5 = yield* release(store, "2026.5", {
        ...BASELINE,
        workStates: ["CA", "NY", "TX", "WA"],
        fieldSchema: FieldAttrsV2,
      });
      store = r5.store;

      const r1Form = r1.snapshot.revisionIds
        .map((id) => ConfigStore.revisionById(store, id))
        .find((rev) => rev?.kind === "form");
      const r5Form = ConfigStore.tipOf(store, { kind: "form", key: "i9" })!;

      // Undoing release 2's label edit lands on release 1's exact content id.
      // Content addressing answers "is this the same form we shipped in
      // 2026.1?" without diffing anything.
      expect(r1Form?.kind).toEqual("form");
      expect(r5Form.cid).toEqual(r1Form?.cid);
      // Same form bytes, but an attribute it reads has since gained an option,
      // so the closure still distinguishes them.
      expect(r5Form.closureCid).not.toEqual(r1Form?.closureCid);

      // -- The history reads as a chain --------------------------------------
      const history = ConfigStore.historyOf(store, { kind: "form", key: "i9" });
      // Newest first, and the head is what the tip resolves to.
      expect(history[0].id).toEqual(r5Form.id);
      expect(history.map((rev) => rev.seq)).toEqual(
        [...history.map((rev) => rev.seq)].sort((a, b) => b - a)
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
                  rev.cid !== ConfigStore.revisionById(store, rev.parentId)!.cid
                    ? "data"
                    : null,
                  rev.closureCid !==
                  ConfigStore.revisionById(store, rev.parentId)!.closureCid
                    ? "closure"
                    : null,
                  rev.schemaCids.join() !==
                  ConfigStore.revisionById(
                    store,
                    rev.parentId
                  )!.schemaCids.join()
                    ? "schema"
                    : null,
                ]
                  .filter(Boolean)
                  .join("+")
          )
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
      store = yield* ConfigStore.setRef(store, "live", r1.snapshot.id);
      store = yield* ConfigStore.setRef(store, "test", r5.snapshot.id);
      expect(ConfigStore.resolveRef(store, "live")?.label).toEqual("2026.1");

      store = yield* ConfigStore.setRef(store, "live", r5.snapshot.id);
      expect(ConfigStore.resolveRef(store, "live")?.rootCid).toEqual(
        r5.snapshot.rootCid
      );
      // Live and test now hold the identical graph - one string comparison,
      // no diff, which is the question "is test in sync with live" reduces to.
      expect(ConfigStore.resolveRef(store, "live")?.rootCid).toEqual(
        ConfigStore.resolveRef(store, "test")?.rootCid
      );

      // Rollback is the same operation in the other direction, and it restores
      // an exact prior state rather than replaying edits.
      store = yield* ConfigStore.setRef(store, "live", r1.snapshot.id);
      expect(ConfigStore.resolveRef(store, "live")?.rootCid).toEqual(
        r1.snapshot.rootCid
      );

      // -- Storage is shared, not copied -------------------------------------
      // Five snapshots of a 12-node graph do not cost 60 rows: identical
      // subtrees across releases collapse onto one entry each.
      expect(store.objects.size).toBeLessThan(
        5 * [...ConfigNode.walk(r1.snapshot.root)].length
      );
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
    })
  );

  it.effect("refuses a snapshot missing something it depends on", () =>
    Effect.gen(function* () {
      const objects = yield* buildAccount(BASELINE);
      // Someone deletes the work_state attribute while a live form still reads
      // it. Today that surfaces as a runtime failure against a real employee;
      // here the release cannot be recorded at all.
      const withoutWorkState = objects.filter(
        (node) => node.key !== "employee.work_state"
      );

      const error = yield* ConfigStore.commit(ConfigStore.empty(), {
        label: "broken",
        objects: withoutWorkState,
      }).pipe(Effect.flip);

      expect(error._tag).toEqual("DanglingRefError");
      expect(error._tag === "DanglingRefError" && error.to).toEqual({
        kind: "attribute",
        key: "employee.work_state",
      });
    })
  );

  it.effect("gives the same ids on every run, from any starting order", () =>
    Effect.gen(function* () {
      // Determinism is the whole contract. Two processes projecting the same
      // configuration must agree on its identity, so neither a re-run nor a
      // different row order out of the database may move a hash.
      const first = yield* release(ConfigStore.empty(), "2026.1", BASELINE);

      const shuffled = [...(yield* buildAccount(BASELINE))].reverse();
      const second = yield* ConfigStore.commit(ConfigStore.empty(), {
        label: "2026.1",
        objects: shuffled,
      });

      expect(second.snapshot.rootCid).toEqual(first.snapshot.rootCid);
      expect(second.created.map((rev) => rev.closureCid).sort()).toEqual(
        first.created.map((rev) => rev.closureCid).sort()
      );
    })
  );
});

describe("schema validity across versions", () => {
  const buildFiveReleases = Effect.gen(function* () {
    let store = ConfigStore.empty();
    for (const [label, config] of [
      ["2026.1", BASELINE],
      ["2026.2", { ...BASELINE, ssnLabel: "Social Security Number" }],
      ["2026.3", { ...BASELINE, workStates: ["CA", "NY", "TX", "WA"] }],
      ["2026.4", { ...BASELINE, fieldSchema: FieldAttrsV2 }],
    ] as ReadonlyArray<[string, AccountConfig]>) {
      store = (yield* release(store, label, config)).store;
    }
    return store;
  });

  it.effect("answers whether deployed config survives a proposed schema", () =>
    Effect.gen(function* () {
      const store = yield* buildFiveReleases;

      // The question worth asking in CI, before the narrowing merges. Today
      // the equivalent failure is found when a customer's form will not load.
      const RequiresHelpText = Schema.Struct({
        ...FieldAttrs.fields,
        helpText: Schema.String,
      });

      const breaking = yield* ConfigStore.recheck(store, {
        kind: FieldKind.name,
        schema: RequiresHelpText,
      });

      expect(breaking.compatible).toEqual([]);
      expect(breaking.revalidated).toEqual([]);
      expect(breaking.violations.map((v) => v.key).sort()).toEqual([
        "employee.ssn",
        "employee.ssn",
        "employee.start_date",
        "employee.work_state",
      ]);
    })
  );

  it.effect("clears a widening without decoding a single instance", () =>
    Effect.gen(function* () {
      const store = yield* buildFiveReleases;

      const Widened = Schema.Struct({
        ...FieldAttrs.fields,
        helpText: Schema.optional(Schema.String),
        placeholder: Schema.optional(Schema.String),
      });

      const result = yield* ConfigStore.recheck(store, {
        kind: FieldKind.name,
        schema: Widened,
      });

      // Every body cleared structurally: one verdict per known schema settles
      // all of them, so nothing landed in `revalidated`.
      expect(result.violations).toEqual([]);
      expect(result.revalidated).toEqual([]);
      expect(result.compatible.length).toBeGreaterThan(0);
    })
  );

  it.effect("falls back to the instance when subsumption cannot decide", () =>
    Effect.gen(function* () {
      const store = yield* buildFiveReleases;

      // Constraining a string is outside the fragment `subsumes` models, so it
      // returns Unknown rather than guessing - and the real bodies settle it.
      // Every stored label is non-empty, so they all pass on revalidation.
      const Constrained = Schema.Struct({
        ...FieldAttrs.fields,
        label: Schema.String.pipe(Schema.minLength(1)),
      });

      const result = yield* ConfigStore.recheck(store, {
        kind: FieldKind.name,
        schema: Constrained,
      });

      expect(result.compatible).toEqual([]);
      expect(result.violations).toEqual([]);
      expect(result.revalidated.length).toBeGreaterThan(0);

      // And a constraint no stored label satisfies is caught the same way,
      // which subsumption alone could never have told us.
      const TooLong = Schema.Struct({
        ...FieldAttrs.fields,
        label: Schema.String.pipe(Schema.minLength(500)),
      });
      const strict = yield* ConfigStore.recheck(store, {
        kind: FieldKind.name,
        schema: TooLong,
      });
      expect(strict.revalidated).toEqual([]);
      expect(strict.violations.length).toBeGreaterThan(0);
    })
  );
});
