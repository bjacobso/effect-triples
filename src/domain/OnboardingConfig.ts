/**
 * The domain: an example onboarding configuration graph.
 *
 * This file is written from the perspective of someone modelling the product -
 * attributes, forms, pages, fields, policies, automations - and it is
 * deliberately free of hashes, stores and releases. Nothing here mentions a
 * content id, because a person declaring what an I-9 form is should not have to
 * know how it is addressed.
 *
 * It was extracted from the scenario test, where it made up 327 of 750 lines.
 * That ratio was the tell: three different authors were sharing one file. The
 * framework author (`CanonicalJson`, `ContentId`, `ConfigNode`, `SchemaId`,
 * `SchemaCompat`) cares about determinism and soundness. The vocabulary author
 * (`Entity`, `ConfigStore`) cares about whether kinds, refs and revisions
 * compose. The domain modeller - this file - cares about none of that, and
 * their tests should read like product questions.
 */

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

import { Effect, Schema } from "effect";

import * as ConfigStore from "../ConfigStore";
import * as Entity from "../Entity";

// ---------------------------------------------------------------------------
// The graph of schemas. One per node kind; this is the whole type system the
// config is allowed to express, and each shape content-addresses itself.
// ---------------------------------------------------------------------------

export const AttributeAttrs = Schema.Struct({
  entityType: Schema.Literal("employee", "employer"),
  path: Schema.String,
  label: Schema.String,
  scalarType: Schema.Literal("text", "date", "enum", "number"),
  enumOptions: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  sensitive: Schema.optionalWith(Schema.Boolean, { default: () => false }),
});

export const FieldAttrs = Schema.Struct({
  path: Schema.String,
  type: Schema.Literal("text", "date", "select", "ssn"),
  label: Schema.String,
  required: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});

/** Release 4 widens this shape without touching any data. */
export const FieldAttrsV2 = Schema.Struct({
  ...FieldAttrs.fields,
  helpText: Schema.optional(Schema.String),
});

export const PageAttrs = Schema.Struct({
  // The semantic key lives in the data rather than arriving as a separate
  // argument, which is what declaring `key` on the entity forces.
  slug: Schema.String,
  title: Schema.String,
  assignee: Schema.Literal("employee", "employer"),
});

export const FormAttrs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
});

export const PolicyAttrs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  status: Schema.Literal("enabled", "disabled"),
});

export const AutomationAttrs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  triggerEntity: Schema.Literal("task", "placement", "employee"),
});

export const ActionAttrs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  actionType: Schema.Literal("create_task", "send_email"),
});

// ---------------------------------------------------------------------------
// The entities. Each declares its kind once, derives its own key, and names its
// relations - `children` for what nests and hashes into it, `ref` for what it
// merely depends on. Targets are thunks because the graph genuinely cycles.
// ---------------------------------------------------------------------------

export const AttributeKind = Entity.kind("attribute");
export const FormKind = Entity.kind("form");
export const PageKind = Entity.kind("form.page");
export const FieldKind = Entity.kind("form.field");
export const PolicyKind = Entity.kind("policy");
export const AutomationKind = Entity.kind("automation");
export const ActionKind = Entity.kind("automation.action");

export const Attribute = Entity.make({
  kind: AttributeKind,
  attrs: AttributeAttrs,
  key: (a) => `${a.entityType}.${a.path}`,
});

export const FormField = Entity.make({
  kind: FieldKind,
  attrs: FieldAttrs,
  key: (a) => a.path,
  refs: { uses_attribute: Entity.ref(AttributeKind) },
});

export const Page = Entity.make({
  kind: PageKind,
  attrs: PageAttrs,
  key: (a) => a.slug,
  children: { field: Entity.children(FieldKind) },
});

export const Form = Entity.make({
  kind: FormKind,
  attrs: FormAttrs,
  key: (a) => a.slug,
  children: { page: Entity.children(PageKind) },
  refs: { scopes: Entity.ref(AutomationKind) },
});

export const Policy = Entity.make({
  kind: PolicyKind,
  attrs: PolicyAttrs,
  key: (a) => a.slug,
  refs: { distributes: Entity.ref(FormKind) },
});

export const Action = Entity.make({
  kind: ActionKind,
  attrs: ActionAttrs,
  key: (a) => a.slug,
  refs: { creates_task: Entity.ref(FormKind) },
});

export const Automation = Entity.make({
  kind: AutomationKind,
  attrs: AutomationAttrs,
  key: (a) => a.slug,
  children: { action: Entity.children(ActionKind) },
  refs: { uses_attribute: Entity.ref(AttributeKind) },
});

// ---------------------------------------------------------------------------
// The account's configuration, parameterised by the things releases change.
// ---------------------------------------------------------------------------

export interface AccountConfig {
  readonly ssnLabel: string;
  readonly workStates: ReadonlyArray<string>;
  readonly fieldSchema: Schema.Schema.AnyNoContext;
}

export const BASELINE: AccountConfig = {
  ssnLabel: "SSN",
  workStates: ["CA", "NY", "TX"],
  fieldSchema: FieldAttrs,
};

export const buildAccount = (config: AccountConfig) =>
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

export const release = (
  store: ConfigStore.ConfigStore,
  label: string,
  config: AccountConfig
) =>
  Effect.gen(function* () {
    const objects = yield* buildAccount(config);
    return yield* ConfigStore.commit(store, { label, objects });
  });

export const changeFor = (
  changes: ReadonlyArray<ConfigStore.ObjectChange>,
  kind: string,
  key: string
) => changes.find((c) => c.kind === kind && c.key === key);

// ---------------------------------------------------------------------------
