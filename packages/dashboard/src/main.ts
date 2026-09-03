import { Button, Input, Select, Textarea } from "@foldkit/ui";
import { Triples } from "@bjacobso/triplex";
import { ConfigStore } from "@bjacobso/triplex/config";
import { Effect, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

import logoUrl from "../../../assets/triplex-logo-dark.svg?url";
import {
  executeQueryText,
  initialQueryText,
  loadDashboard,
  loadEntityTypePage,
  queryPresets,
} from "./data.js";
import {
  DashboardData,
  EntityTypePageView,
  Model,
  Page,
  QueryView,
  type TransactionView,
} from "./model.js";

export const Message = defineMessageUnion({
  SelectedPage: { page: Page },
  SelectedEntityType: { entityType: Schema.String },
  SelectedForm: { formKey: Schema.String },
  ChangedFormField: { field: Schema.String, value: Schema.String },
  RequestedValidateForm: {},
  SelectedConfigObject: { object: Schema.String },
  RequestedNextEntityTypePage: {},
  RequestedPreviousEntityTypePage: {},
  ChangedEntitySearch: { value: Schema.String },
  SelectedEntity: { entityId: Schema.String },
  SelectedQueryPreset: { preset: Schema.String },
  ChangedQueryText: { value: Schema.String },
  RequestedQuery: {},
  RequestedRefresh: {},
  SucceededLoadDashboard: { data: DashboardData },
  SucceededLoadEntityTypePage: { page: EntityTypePageView },
  SucceededRunQuery: { result: QueryView },
  FailedDashboardCommand: { message: Schema.String },
});
export type Message = typeof Message.Type;

export const initialModel: Model = {
  page: "overview",
  data: null,
  selectedEntityId: null,
  selectedEntityType: null,
  entityTypePage: null,
  entityTypeCursor: null,
  entityTypeBackStack: [],
  selectedFormKey: null,
  formValues: {},
  selectedConfigObject: null,
  entitySearch: "",
  queryPreset: queryPresets[0].id,
  queryText: initialQueryText,
  queryResult: null,
  busy: true,
  error: null,
  notice: null,
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

export const LoadDashboard = Command.define("LoadDashboard", {
  messages: [Message.SucceededLoadDashboard, Message.FailedDashboardCommand],
  execute: loadDashboard.pipe(
    Effect.map((data) => Message.SucceededLoadDashboard({ data })),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedDashboardCommand({ message: errorMessage(error) })),
    ),
  ),
});

export const RunQuery = Command.define("RunQuery", {
  args: { source: Schema.String },
  messages: [Message.SucceededRunQuery, Message.FailedDashboardCommand],
  execute: ({ source }) =>
    executeQueryText(source).pipe(
      Effect.map((result) => Message.SucceededRunQuery({ result })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedDashboardCommand({ message: errorMessage(error) })),
      ),
    ),
});

export const LoadEntityTypePage = Command.define("LoadEntityTypePage", {
  args: {
    entityType: Schema.String,
    cursor: Schema.NullOr(Schema.String),
  },
  messages: [Message.SucceededLoadEntityTypePage, Message.FailedDashboardCommand],
  execute: ({ entityType, cursor }) =>
    loadEntityTypePage(entityType, cursor).pipe(
      Effect.map((page) => Message.SucceededLoadEntityTypePage({ page })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedDashboardCommand({ message: errorMessage(error) })),
      ),
    ),
});

type Resources = Triples | ConfigStore.ConfigStore;

export const init: Runtime.ApplicationInit<Model, Message, void, Resources> = () => ({
  model: initialModel,
  commands: [LoadDashboard()],
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, Resources>>(message, {
    SelectedPage: ({ page }) => ({ model: { ...model, page, notice: null } }),
    SelectedEntityType: ({ entityType }) => ({
      model: {
        ...model,
        selectedEntityType: entityType,
        entityTypePage: null,
        entityTypeCursor: null,
        entityTypeBackStack: [],
        busy: true,
        error: null,
      },
      commands: [LoadEntityTypePage({ entityType, cursor: null })],
    }),
    SelectedForm: ({ formKey }) => ({
      model: { ...model, selectedFormKey: formKey, formValues: {}, notice: null, error: null },
    }),
    ChangedFormField: ({ field, value }) => ({
      model: {
        ...model,
        formValues: { ...model.formValues, [field]: value },
        notice: null,
        error: null,
      },
    }),
    RequestedValidateForm: () => {
      const form = model.data?.forms.find((item) => item.key === model.selectedFormKey);
      const missing = form?.fields.filter(
        (field) => field.required && (model.formValues[field.name]?.trim() ?? "") === "",
      );
      return missing !== undefined && missing.length > 0
        ? {
            model: {
              ...model,
              error: `Complete ${missing.map((field) => field.label).join(", ")}.`,
              notice: null,
            },
          }
        : {
            model: {
              ...model,
              error: null,
              notice:
                "Form values satisfy the configured preview contract. No application command was executed.",
            },
          };
    },
    SelectedConfigObject: ({ object }) => ({
      model: { ...model, selectedConfigObject: object, notice: null },
    }),
    RequestedNextEntityTypePage: () => {
      const cursor = model.entityTypePage?.nextCursor;
      if (model.selectedEntityType === null || cursor === null || cursor === undefined) {
        return { model };
      }
      return {
        model: {
          ...model,
          entityTypeCursor: cursor,
          entityTypeBackStack: [...model.entityTypeBackStack, model.entityTypeCursor],
          busy: true,
          error: null,
        },
        commands: [LoadEntityTypePage({ entityType: model.selectedEntityType, cursor })],
      };
    },
    RequestedPreviousEntityTypePage: () => {
      if (model.selectedEntityType === null || model.entityTypeBackStack.length === 0) {
        return { model };
      }
      const cursor = model.entityTypeBackStack.at(-1) ?? null;
      return {
        model: {
          ...model,
          entityTypeCursor: cursor,
          entityTypeBackStack: model.entityTypeBackStack.slice(0, -1),
          busy: true,
          error: null,
        },
        commands: [LoadEntityTypePage({ entityType: model.selectedEntityType, cursor })],
      };
    },
    ChangedEntitySearch: ({ value }) => ({
      model: { ...model, entitySearch: value, notice: null },
    }),
    SelectedEntity: ({ entityId }) => ({
      model: { ...model, selectedEntityId: entityId, notice: null },
    }),
    SelectedQueryPreset: ({ preset }) => {
      const selected = queryPresets.find((item) => item.id === preset);
      return {
        model: {
          ...model,
          queryPreset: preset,
          queryText:
            selected === undefined ? model.queryText : JSON.stringify(selected.query, null, 2),
          queryResult: null,
          notice: null,
        },
      };
    },
    ChangedQueryText: ({ value }) => ({
      model: { ...model, queryText: value, queryPreset: "custom", notice: null },
    }),
    RequestedQuery: () => ({
      model: { ...model, busy: true, error: null, notice: null },
      commands: [RunQuery({ source: model.queryText })],
    }),
    RequestedRefresh: () => ({
      model: { ...model, busy: true, error: null, notice: null },
      commands: [LoadDashboard()],
    }),
    SucceededLoadDashboard: ({ data }) => ({
      model: (() => {
        const selectedEntityType = data.entityTypes.some(
          (item) => item.name === model.selectedEntityType,
        )
          ? model.selectedEntityType
          : (data.entityTypes[0]?.name ?? null);
        return {
          ...model,
          data,
          selectedEntityId: model.selectedEntityId ?? data.entities[0]?.id ?? null,
          selectedEntityType,
          selectedFormKey: data.forms.some((form) => form.key === model.selectedFormKey)
            ? model.selectedFormKey
            : (data.forms[0]?.key ?? null),
          selectedConfigObject: data.config.objects.some(
            (object) => `${object.kind}\u0000${object.key}` === model.selectedConfigObject,
          )
            ? model.selectedConfigObject
            : data.config.objects[0] === undefined
              ? null
              : `${data.config.objects[0].kind}\u0000${data.config.objects[0].key}`,
          entityTypePage: null,
          entityTypeCursor: null,
          entityTypeBackStack: [],
          busy: true,
          error: null,
        };
      })(),
      commands: [
        RunQuery({ source: model.queryText }),
        ...(data.entityTypes[0] === undefined
          ? []
          : [
              LoadEntityTypePage({
                entityType:
                  data.entityTypes.find((item) => item.name === model.selectedEntityType)?.name ??
                  data.entityTypes[0].name,
                cursor: null,
              }),
            ]),
      ],
    }),
    SucceededLoadEntityTypePage: ({ page }) => ({
      model: { ...model, entityTypePage: page, busy: false, error: null },
    }),
    SucceededRunQuery: ({ result }) => ({
      model: { ...model, queryResult: result, busy: false, error: null },
    }),
    FailedDashboardCommand: ({ message: failure }) => ({
      model: { ...model, busy: false, error: failure },
    }),
  });

type IconName =
  | "overview"
  | "entities"
  | "query"
  | "journal"
  | "config"
  | "refresh"
  | "arrow"
  | "database"
  | "spark";

const iconPaths: Readonly<Record<IconName, string>> = {
  overview: "M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z",
  entities: "M12 3 3.5 7.5 12 12l8.5-4.5L12 3ZM3.5 12 12 16.5l8.5-4.5M3.5 16.5 12 21l8.5-4.5",
  query: "m14 4 6 6-6 6M20 10H9a5 5 0 0 0-5 5v5",
  journal: "M12 8v5l3 2M4.9 19.1A9 9 0 1 0 3 14M3 20v-6h6",
  config:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z",
  refresh: "M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.6-2.6L20 9M4 15l2.3 2.6A7 7 0 0 0 17.9 15",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  database:
    "M20 6c0 1.7-3.6 3-8 3S4 7.7 4 6s3.6-3 8-3 8 1.3 8 3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  spark:
    "m12 3 1.2 4.8L18 9l-4.8 1.2L12 15l-1.2-4.8L6 9l4.8-1.2L12 3Zm6 11 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z",
};

const icon = (name: IconName, h: HtmlBuilder<Message>): Html =>
  h.svg(
    [
      h.Class("h-5 w-5 shrink-0"),
      h.ViewBox("0 0 24 24"),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("1.75"),
      h.StrokeLinecap("round"),
      h.StrokeLinejoin("round"),
      h.AriaHidden(true),
    ],
    [h.path([h.D(iconPaths[name])], [])],
  );

const uiButton = (
  label: string,
  onClick: Message,
  h: HtmlBuilder<Message>,
  options: {
    readonly kind?: "primary" | "secondary" | "quiet";
    readonly disabled?: boolean;
    readonly icon?: IconName;
  } = {},
): Html => {
  const kind = options.kind ?? "secondary";
  const styles =
    kind === "primary"
      ? "bg-[#1769ff] text-white shadow-[0_8px_20px_rgba(23,105,255,0.2)] hover:bg-[#0f5ce8]"
      : kind === "quiet"
        ? "bg-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        : "border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50";
  return Button.view(
    {
      onClick,
      isDisabled: options.disabled ?? false,
      toView: ({ button }) =>
        h.button(
          [
            ...button,
            h.Class(
              `inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-3.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-100 disabled:cursor-wait disabled:opacity-55 ${styles}`,
            ),
          ],
          [...(options.icon === undefined ? [] : [icon(options.icon, h)]), label],
        ),
    },
    h,
  );
};

const navItems: ReadonlyArray<{
  readonly page: Page;
  readonly label: string;
  readonly icon: IconName;
}> = [
  { page: "overview", label: "Overview", icon: "overview" },
  { page: "entities", label: "Entities", icon: "entities" },
  { page: "forms", label: "Forms", icon: "spark" },
  { page: "query", label: "Datalog", icon: "query" },
  { page: "journal", label: "Journal", icon: "journal" },
  { page: "config", label: "Configuration", icon: "config" },
];

const sidebar = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.aside(
    [
      h.Class(
        "border-white/8 bg-[#101827] text-white lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-68 lg:flex-col lg:border-r",
      ),
    ],
    [
      h.div(
        [
          h.Class(
            "flex items-center justify-between border-b border-white/8 px-5 py-5 lg:block lg:border-0 lg:px-7 lg:pt-8 lg:pb-5",
          ),
        ],
        [
          h.img([h.Src(logoUrl), h.Alt("Triplex"), h.Class("h-auto w-31 lg:w-36")]),
          h.div(
            [
              h.Class(
                "hidden items-center gap-2 text-[11px] font-medium text-slate-400 lg:mt-4 lg:flex",
              ),
            ],
            [
              h.span(
                [
                  h.Class(
                    "h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_0_4px_rgba(52,211,153,0.1)]",
                  ),
                ],
                [],
              ),
              "In-memory database online",
            ],
          ),
        ],
      ),
      h.nav(
        [
          h.Class(
            "no-scrollbar flex gap-1 overflow-x-auto px-3 py-3 lg:flex-1 lg:flex-col lg:overflow-visible lg:px-4 lg:py-5",
          ),
        ],
        navItems.map((item) =>
          Button.view(
            {
              onClick: Message.SelectedPage({ page: item.page }),
              toView: ({ button }) =>
                h.button(
                  [
                    ...button,
                    h.Class(
                      item.page === model.page
                        ? "flex shrink-0 items-center gap-3 rounded-xl bg-white/10 px-3.5 py-3 text-sm font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] lg:w-full"
                        : "flex shrink-0 items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-medium text-slate-400 transition hover:bg-white/6 hover:text-white lg:w-full",
                    ),
                  ],
                  [icon(item.icon, h), item.label],
                ),
            },
            h,
          ),
        ),
      ),
      h.div(
        [h.Class("hidden border-t border-white/8 p-5 lg:block")],
        [
          h.div(
            [h.Class("rounded-2xl bg-[#17233a] p-4")],
            [
              h.div(
                [h.Class("mb-2 flex items-center gap-2 text-xs font-semibold text-blue-300")],
                [icon("spark", h), "Built on Effect"],
              ),
              h.p(
                [h.Class("text-xs leading-5 text-slate-400")],
                ["Every interaction is a typed Foldkit message and every read is an Effect."],
              ),
            ],
          ),
        ],
      ),
    ],
  );

const pageHeader = (
  eyebrow: string,
  title: string,
  description: string,
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.header(
    [h.Class("mb-7 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between")],
    [
      h.div(
        [],
        [
          h.p(
            [h.Class("mb-2 text-xs font-bold tracking-[0.18em] text-[#1769ff] uppercase")],
            [eyebrow],
          ),
          h.h1(
            [h.Class("text-3xl font-bold tracking-[-0.035em] text-slate-950 sm:text-[2.15rem]")],
            [title],
          ),
          h.p([h.Class("mt-2 max-w-2xl text-sm leading-6 text-slate-500")], [description]),
        ],
      ),
      uiButton(model.busy ? "Refreshing…" : "Refresh data", Message.RequestedRefresh(), h, {
        kind: "secondary",
        disabled: model.busy,
        icon: "refresh",
      }),
    ],
  );

const metricTone = (tone: "blue" | "violet" | "green" | "amber"): string => {
  switch (tone) {
    case "blue":
      return "bg-blue-50 text-blue-700 ring-blue-100";
    case "violet":
      return "bg-violet-50 text-violet-700 ring-violet-100";
    case "green":
      return "bg-emerald-50 text-emerald-700 ring-emerald-100";
    case "amber":
      return "bg-amber-50 text-amber-700 ring-amber-100";
  }
};

const shortId = (value: string): string =>
  value.length <= 20 ? value : `${value.slice(0, 11)}…${value.slice(-7)}`;

const formatInstant = (value: number): string =>
  new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));

const overviewView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const data = model.data!;
  const recent = data.transactions.slice(0, 4);
  const relationships = data.entities.flatMap((entity) =>
    entity.facts
      .filter((fact) => fact.valueType === "ref")
      .map((fact) => ({
        from: entity.name,
        attribute: fact.attribute,
        to: data.entities.find((candidate) => candidate.id === fact.value)?.name ?? fact.value,
      })),
  );

  return h.div(
    [],
    [
      pageHeader(
        "Database explorer",
        "See the database think",
        "Entity types, facts, graph relationships, derived candidates, causal history, and content-addressed configuration—discovered from this database.",
        model,
        h,
      ),
      h.div(
        [h.Class("mb-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4")],
        data.metrics.map((metric) =>
          h.article(
            [
              h.Class(
                "rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]",
              ),
            ],
            [
              h.div(
                [
                  h.Class(
                    `mb-4 inline-flex rounded-xl px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase ring-1 ${metricTone(metric.tone)}`,
                  ),
                ],
                [metric.label],
              ),
              h.p(
                [h.Class("text-3xl font-bold tracking-[-0.04em] text-slate-950")],
                [metric.value],
              ),
              h.p([h.Class("mt-1 text-xs text-slate-500")], [metric.detail]),
            ],
          ),
        ),
      ),
      h.div(
        [h.Class("grid gap-6 xl:grid-cols-[1.15fr_0.85fr]")],
        [
          h.section(
            [
              h.Class(
                "rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]",
              ),
            ],
            [
              h.div(
                [h.Class("flex items-center justify-between border-b border-slate-100 px-5 py-4")],
                [
                  h.div(
                    [],
                    [
                      h.h2([h.Class("text-sm font-bold text-slate-900")], ["Recent transactions"]),
                      h.p(
                        [h.Class("mt-0.5 text-xs text-slate-500")],
                        ["Newest commits from the causal journal"],
                      ),
                    ],
                  ),
                  h.span(
                    [
                      h.Class(
                        "rounded-lg bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600",
                      ),
                    ],
                    [`position ${data.position}`],
                  ),
                ],
              ),
              h.div(
                [h.Class("divide-y divide-slate-100")],
                recent.map((transaction) => transactionRow(transaction, h)),
              ),
              Button.view(
                {
                  onClick: Message.SelectedPage({ page: "journal" }),
                  toView: ({ button }) =>
                    h.button(
                      [
                        ...button,
                        h.Class(
                          "flex w-full items-center justify-between border-t border-slate-100 px-5 py-4 text-sm font-semibold text-[#1769ff] hover:bg-blue-50/40",
                        ),
                      ],
                      ["Open complete journal", icon("arrow", h)],
                    ),
                },
                h,
              ),
            ],
          ),
          h.div(
            [h.Class("grid gap-6")],
            [
              h.section(
                [
                  h.Class(
                    "rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]",
                  ),
                ],
                [
                  h.div(
                    [h.Class("mb-4 flex items-start justify-between")],
                    [
                      h.div(
                        [],
                        [
                          h.h2(
                            [h.Class("text-sm font-bold text-slate-900")],
                            ["Derived candidates"],
                          ),
                          h.p(
                            [h.Class("mt-0.5 text-xs text-slate-500")],
                            ["Discovered from the active configuration release"],
                          ),
                        ],
                      ),
                      h.span(
                        [
                          h.Class(
                            "flex h-9 w-9 items-center justify-center rounded-xl bg-amber-50 text-amber-600",
                          ),
                        ],
                        [icon("spark", h)],
                      ),
                    ],
                  ),
                  ...(data.candidates.length === 0
                    ? [
                        h.p(
                          [h.Class("rounded-xl bg-emerald-50 p-4 text-sm text-emerald-700")],
                          ["No materialized candidates in the active release."],
                        ),
                      ]
                    : data.candidates.map((candidate) =>
                        h.div(
                          [h.Class("rounded-xl border border-amber-200 bg-amber-50/60 p-4")],
                          [
                            h.div(
                              [h.Class("flex items-center justify-between gap-3")],
                              [
                                h.p(
                                  [h.Class("font-semibold text-slate-900")],
                                  [shortId(candidate.id)],
                                ),
                                h.span(
                                  [
                                    h.Class(
                                      "rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-700",
                                    ),
                                  ],
                                  ["candidate"],
                                ),
                              ],
                            ),
                            h.div(
                              [h.Class("mt-3 flex flex-wrap gap-1.5")],
                              candidate.bindings.map((binding) =>
                                h.span(
                                  [
                                    h.Class(
                                      "rounded-md bg-white px-2 py-1 font-mono text-[10px] text-slate-600 ring-1 ring-amber-100",
                                    ),
                                  ],
                                  [`${binding.variable} = ${binding.value}`],
                                ),
                              ),
                            ),
                            h.p(
                              [h.Class("mt-1 text-xs leading-5 text-slate-500")],
                              [
                                `${candidate.sourceCount} source facts across ${candidate.sourceTransactionCount} transactions`,
                              ],
                            ),
                            h.code(
                              [h.Class("mt-3 block truncate text-[10px] text-slate-400")],
                              [candidate.revision],
                            ),
                          ],
                        ),
                      )),
                ],
              ),
              h.section(
                [
                  h.Class(
                    "rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]",
                  ),
                ],
                [
                  h.div(
                    [h.Class("mb-4 flex items-center justify-between")],
                    [
                      h.h2([h.Class("text-sm font-bold text-slate-900")], ["Graph edges"]),
                      h.span(
                        [h.Class("text-xs font-semibold text-slate-400")],
                        [`${relationships.length} relationships`],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("space-y-3")],
                    relationships
                      .slice(0, 4)
                      .map((edge) =>
                        h.div(
                          [h.Class("grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs")],
                          [
                            h.span(
                              [
                                h.Class(
                                  "truncate rounded-lg bg-slate-50 px-2.5 py-2 font-medium text-slate-700",
                                ),
                              ],
                              [edge.from],
                            ),
                            h.span([h.Class("text-slate-300")], ["→"]),
                            h.span(
                              [
                                h.Class(
                                  "truncate rounded-lg bg-blue-50 px-2.5 py-2 font-medium text-blue-700",
                                ),
                              ],
                              [edge.to],
                            ),
                          ],
                        ),
                      ),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const transactionRow = (transaction: TransactionView, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex items-center gap-4 px-5 py-4")],
    [
      h.div(
        [
          h.Class(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-500",
          ),
        ],
        [icon("journal", h)],
      ),
      h.div(
        [h.Class("min-w-0 flex-1")],
        [
          h.div(
            [h.Class("flex items-center gap-2")],
            [
              h.p(
                [h.Class("truncate text-sm font-semibold text-slate-900")],
                [transaction.actor ?? "Triplex system"],
              ),
              h.span(
                [
                  h.Class(
                    "rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500",
                  ),
                ],
                [`#${transaction.position}`],
              ),
            ],
          ),
          h.p(
            [h.Class("mt-0.5 truncate font-mono text-[11px] text-slate-400")],
            [transaction.commandId ?? transaction.id],
          ),
        ],
      ),
      h.div(
        [h.Class("shrink-0 text-right")],
        [
          h.p(
            [h.Class("text-xs font-semibold text-slate-600")],
            [`${transaction.changes.length} changes`],
          ),
          h.p([h.Class("mt-0.5 text-[11px] text-slate-400")], [formatInstant(transaction.instant)]),
        ],
      ),
    ],
  );

export const entityFactExplorer = (model: Model, h: HtmlBuilder<Message>): Html => {
  const data = model.data!;
  const search = model.entitySearch.trim().toLowerCase();
  const entities = data.entities.filter(
    (entity) =>
      search === "" || `${entity.id} ${entity.name} ${entity.type}`.toLowerCase().includes(search),
  );
  const selected =
    data.entities.find((entity) => entity.id === model.selectedEntityId) ?? entities[0];

  return h.div(
    [],
    [
      pageHeader(
        "Fact browser",
        "Explore entities",
        "Inspect each current fact, its valid-time interval, and the transaction that recorded it.",
        model,
        h,
      ),
      h.div(
        [
          h.Class(
            "grid min-h-[650px] overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] xl:grid-cols-[320px_1fr]",
          ),
        ],
        [
          h.aside(
            [h.Class("border-b border-slate-200 bg-slate-50/60 xl:border-r xl:border-b-0")],
            [
              h.div(
                [h.Class("border-b border-slate-200 p-4")],
                [
                  Input.view(
                    {
                      id: "entity-search",
                      value: model.entitySearch,
                      placeholder: "Search entities…",
                      onInput: (value) => Message.ChangedEntitySearch({ value }),
                      toView: ({ input }) =>
                        h.div(
                          [h.Class("relative")],
                          [
                            h.span(
                              [
                                h.Class(
                                  "pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400",
                                ),
                              ],
                              [icon("query", h)],
                            ),
                            h.input([
                              ...input,
                              h.Class(
                                "h-11 w-full rounded-xl border border-slate-200 bg-white pr-3 pl-10 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-50",
                              ),
                            ]),
                          ],
                        ),
                    },
                    h,
                  ),
                ],
              ),
              h.div(
                [h.Class("max-h-[590px] overflow-y-auto p-2")],
                entities.map((entity) =>
                  Button.view(
                    {
                      onClick: Message.SelectedEntity({ entityId: entity.id }),
                      toView: ({ button }) =>
                        h.button(
                          [
                            ...button,
                            h.Class(
                              entity.id === selected?.id
                                ? "mb-1 w-full rounded-xl bg-white p-3 text-left shadow-sm ring-1 ring-slate-200"
                                : "mb-1 w-full rounded-xl p-3 text-left hover:bg-white/80",
                            ),
                          ],
                          [
                            h.div(
                              [h.Class("flex items-center justify-between gap-2")],
                              [
                                h.p(
                                  [h.Class("truncate text-sm font-semibold text-slate-900")],
                                  [entity.name],
                                ),
                                h.span(
                                  [
                                    h.Class(
                                      "text-[10px] font-bold tracking-wide text-slate-400 uppercase",
                                    ),
                                  ],
                                  [entity.type],
                                ),
                              ],
                            ),
                            h.div(
                              [h.Class("mt-1.5 flex items-center justify-between gap-2")],
                              [
                                h.p(
                                  [h.Class("truncate font-mono text-[10px] text-slate-400")],
                                  [entity.id],
                                ),
                                h.span(
                                  [
                                    h.Class(
                                      "text-[10px] font-bold tracking-wide text-slate-400 uppercase",
                                    ),
                                  ],
                                  [entity.type],
                                ),
                              ],
                            ),
                          ],
                        ),
                    },
                    h,
                  ),
                ),
              ),
            ],
          ),
          selected === undefined
            ? h.div(
                [h.Class("flex items-center justify-center p-12 text-sm text-slate-500")],
                ["No entities match this search."],
              )
            : h.section(
                [h.Class("min-w-0")],
                [
                  h.div(
                    [
                      h.Class(
                        "flex flex-col gap-4 border-b border-slate-100 p-5 sm:flex-row sm:items-center sm:justify-between",
                      ),
                    ],
                    [
                      h.div(
                        [],
                        [
                          h.div(
                            [h.Class("mb-1 flex items-center gap-2")],
                            [
                              h.span(
                                [
                                  h.Class(
                                    "text-[11px] font-bold tracking-[0.15em] text-[#1769ff] uppercase",
                                  ),
                                ],
                                [selected.type],
                              ),
                            ],
                          ),
                          h.h2(
                            [h.Class("text-xl font-bold tracking-tight text-slate-950")],
                            [selected.name],
                          ),
                          h.code([h.Class("mt-1 block text-[11px] text-slate-400")], [selected.id]),
                        ],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("overflow-x-auto")],
                    [
                      h.table(
                        [h.Class("w-full text-left text-sm")],
                        [
                          h.thead(
                            [
                              h.Class(
                                "border-b border-slate-100 bg-slate-50/50 text-[10px] font-bold tracking-[0.12em] text-slate-400 uppercase",
                              ),
                            ],
                            [
                              h.tr(
                                [],
                                [
                                  h.th([h.Class("px-5 py-3")], ["Attribute"]),
                                  h.th([h.Class("px-5 py-3")], ["Value"]),
                                  h.th([h.Class("px-5 py-3")], ["Valid from"]),
                                  h.th([h.Class("px-5 py-3")], ["Recorded by"]),
                                ],
                              ),
                            ],
                          ),
                          h.tbody(
                            [h.Class("divide-y divide-slate-100")],
                            selected.facts.map((fact) =>
                              h.tr(
                                [h.Class("align-top hover:bg-slate-50/60")],
                                [
                                  h.td(
                                    [h.Class("px-5 py-4")],
                                    [
                                      h.code(
                                        [
                                          h.Class(
                                            "whitespace-nowrap text-xs font-semibold text-blue-700",
                                          ),
                                        ],
                                        [fact.attribute],
                                      ),
                                      h.p(
                                        [h.Class("mt-1 text-[10px] text-slate-400")],
                                        [fact.valueType],
                                      ),
                                    ],
                                  ),
                                  h.td(
                                    [
                                      h.Class(
                                        "max-w-[240px] px-5 py-4 font-medium break-words text-slate-800",
                                      ),
                                    ],
                                    [fact.value],
                                  ),
                                  h.td(
                                    [h.Class("whitespace-nowrap px-5 py-4 text-xs text-slate-500")],
                                    [
                                      formatInstant(fact.validFrom),
                                      h.p(
                                        [h.Class("mt-1 text-[10px] text-slate-400")],
                                        [
                                          fact.validTo === null
                                            ? "open interval"
                                            : `until ${formatInstant(fact.validTo)}`,
                                        ],
                                      ),
                                    ],
                                  ),
                                  h.td(
                                    [h.Class("px-5 py-4")],
                                    [
                                      h.code(
                                        [
                                          h.Class(
                                            "block max-w-44 truncate text-[10px] text-slate-500",
                                          ),
                                        ],
                                        [fact.txId ?? "direct write"],
                                      ),
                                      h.p(
                                        [h.Class("mt-1 text-[10px] text-slate-400")],
                                        [formatInstant(fact.recordedAt)],
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
        ],
      ),
    ],
  );
};

const entitiesView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const data = model.data!;
  const page = model.entityTypePage;
  const selectedType = model.selectedEntityType;

  return h.div(
    [],
    [
      pageHeader(
        "Reflected schema",
        "Browse entity types",
        "Choose a type discovered from stored facts, then page through a temporal-basis-pinned table of its entities and attributes.",
        model,
        h,
      ),
      h.div(
        [
          h.Class(
            "grid min-h-[620px] overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] xl:grid-cols-[280px_minmax(0,1fr)]",
          ),
        ],
        [
          h.aside(
            [h.Class("border-b border-slate-200 bg-slate-50/70 p-3 xl:border-r xl:border-b-0")],
            [
              h.div(
                [h.Class("px-3 pt-2 pb-3")],
                [
                  h.p(
                    [h.Class("text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase")],
                    ["Entity types"],
                  ),
                  h.p(
                    [h.Class("mt-1 text-xs text-slate-500")],
                    [`${data.entityTypes.length} discovered from the current database`],
                  ),
                ],
              ),
              ...data.entityTypes.map((entityType) =>
                Button.view(
                  {
                    onClick: Message.SelectedEntityType({ entityType: entityType.name }),
                    toView: ({ button }) =>
                      h.button(
                        [
                          ...button,
                          h.Class(
                            entityType.name === selectedType
                              ? "mb-1 flex w-full items-center justify-between rounded-xl bg-white px-3.5 py-3 text-left shadow-sm ring-1 ring-slate-200"
                              : "mb-1 flex w-full items-center justify-between rounded-xl px-3.5 py-3 text-left transition hover:bg-white",
                          ),
                        ],
                        [
                          h.div(
                            [h.Class("min-w-0")],
                            [
                              h.p(
                                [h.Class("truncate text-sm font-semibold text-slate-900")],
                                [entityType.name],
                              ),
                              h.p(
                                [h.Class("mt-0.5 text-[10px] text-slate-400")],
                                [`${entityType.attributeCount} attributes`],
                              ),
                            ],
                          ),
                          h.span(
                            [
                              h.Class(
                                "rounded-lg bg-blue-50 px-2 py-1 text-xs font-bold text-blue-700",
                              ),
                            ],
                            [String(entityType.entityCount)],
                          ),
                        ],
                      ),
                  },
                  h,
                ),
              ),
            ],
          ),
          h.section(
            [h.Class("min-w-0")],
            [
              h.div(
                [
                  h.Class(
                    "flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-4",
                  ),
                ],
                [
                  h.div(
                    [],
                    [
                      h.h2(
                        [h.Class("text-lg font-bold text-slate-950")],
                        [selectedType ?? "No type selected"],
                      ),
                      h.p(
                        [h.Class("mt-0.5 text-xs text-slate-500")],
                        [
                          page === null
                            ? "Loading entity page…"
                            : `${page.totalCount} entities · ${page.columns.length} reflected columns`,
                        ],
                      ),
                    ],
                  ),
                  page === null
                    ? h.empty
                    : h.span(
                        [
                          h.Class(
                            "rounded-lg bg-slate-100 px-2.5 py-1 font-mono text-[10px] text-slate-500",
                          ),
                        ],
                        [`page ${model.entityTypeBackStack.length + 1}`],
                      ),
                ],
              ),
              page === null
                ? h.div(
                    [h.Class("flex min-h-96 items-center justify-center text-sm text-slate-400")],
                    [model.busy ? "Reading a stable page…" : "Select an entity type."],
                  )
                : page.entities.length === 0
                  ? h.div(
                      [h.Class("flex min-h-96 items-center justify-center text-sm text-slate-400")],
                      ["No entities are visible at this cursor snapshot."],
                    )
                  : h.div(
                      [h.Class("overflow-x-auto")],
                      [
                        h.table(
                          [h.Class("w-full min-w-max text-left text-sm")],
                          [
                            h.thead(
                              [h.Class("border-b border-slate-100 bg-slate-50/60")],
                              [
                                h.tr(
                                  [],
                                  [
                                    h.th(
                                      [
                                        h.Class(
                                          "sticky left-0 bg-slate-50 px-5 py-3 text-[10px] font-bold tracking-wide text-slate-400 uppercase",
                                        ),
                                      ],
                                      ["Entity"],
                                    ),
                                    ...page.columns.map((column) =>
                                      h.th(
                                        [
                                          h.Class(
                                            "px-4 py-3 font-mono text-[10px] font-semibold whitespace-nowrap text-slate-500",
                                          ),
                                        ],
                                        [column],
                                      ),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                            h.tbody(
                              [h.Class("divide-y divide-slate-100")],
                              page.entities.map((entity) =>
                                h.tr(
                                  [h.Class("align-top hover:bg-blue-50/30")],
                                  [
                                    h.td(
                                      [h.Class("sticky left-0 bg-white px-5 py-4")],
                                      [
                                        h.p(
                                          [
                                            h.Class(
                                              "max-w-52 truncate font-semibold text-slate-900",
                                            ),
                                          ],
                                          [entity.name],
                                        ),
                                        h.code(
                                          [
                                            h.Class(
                                              "mt-1 block max-w-52 truncate text-[10px] text-slate-400",
                                            ),
                                          ],
                                          [entity.id],
                                        ),
                                      ],
                                    ),
                                    ...page.columns.map((column) => {
                                      const values = entity.facts
                                        .filter((fact) => fact.attribute === column)
                                        .map((fact) => fact.value);
                                      return h.td(
                                        [h.Class("max-w-72 px-4 py-4 text-xs text-slate-700")],
                                        [values.length === 0 ? "—" : values.join(", ")],
                                      );
                                    }),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
              h.div(
                [h.Class("flex items-center justify-between border-t border-slate-100 px-5 py-4")],
                [
                  h.p(
                    [h.Class("text-xs text-slate-400")],
                    [page === null ? "" : `Showing ${page.entities.length} of ${page.totalCount}`],
                  ),
                  h.div(
                    [h.Class("flex gap-2")],
                    [
                      uiButton("Previous", Message.RequestedPreviousEntityTypePage(), h, {
                        kind: "secondary",
                        disabled: model.busy || model.entityTypeBackStack.length === 0,
                      }),
                      uiButton("Next", Message.RequestedNextEntityTypePage(), h, {
                        kind: "primary",
                        disabled: model.busy || page?.nextCursor === null || page === null,
                      }),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const formsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const forms = model.data!.forms;
  const selected = forms.find((form) => form.key === model.selectedFormKey) ?? forms[0];

  return h.div(
    [],
    [
      pageHeader(
        "Configuration preview",
        "Render configured forms",
        "The renderer understands the opt-in triplex.form/v1 contract; labels, fields, ordering, options, and requiredness all come from the active release.",
        model,
        h,
      ),
      h.div(
        [
          h.Class(
            "grid overflow-hidden rounded-2xl border border-slate-200 bg-white lg:grid-cols-[280px_1fr]",
          ),
        ],
        [
          h.aside(
            [h.Class("border-b border-slate-200 bg-slate-50/70 p-3 lg:border-r lg:border-b-0")],
            [
              h.p(
                [
                  h.Class(
                    "px-3 pt-2 pb-3 text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase",
                  ),
                ],
                [`${forms.length} renderable forms`],
              ),
              ...forms.map((form) =>
                Button.view(
                  {
                    onClick: Message.SelectedForm({ formKey: form.key }),
                    toView: ({ button }) =>
                      h.button(
                        [
                          ...button,
                          h.Class(
                            form.key === selected?.key
                              ? "mb-1 w-full rounded-xl bg-white p-3 text-left shadow-sm ring-1 ring-slate-200"
                              : "mb-1 w-full rounded-xl p-3 text-left hover:bg-white",
                          ),
                        ],
                        [
                          h.p([h.Class("text-sm font-semibold text-slate-900")], [form.title]),
                          h.code(
                            [h.Class("mt-1 block truncate text-[10px] text-slate-400")],
                            [form.key],
                          ),
                        ],
                      ),
                  },
                  h,
                ),
              ),
            ],
          ),
          selected === undefined
            ? h.div(
                [h.Class("flex min-h-96 items-center justify-center p-10 text-sm text-slate-400")],
                ["No form in this release opts into triplex.form/v1."],
              )
            : h.section(
                [h.Class("mx-auto w-full max-w-2xl p-6 sm:p-10")],
                [
                  h.div(
                    [h.Class("mb-8")],
                    [
                      h.span(
                        [
                          h.Class(
                            "rounded-lg bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-700",
                          ),
                        ],
                        ["CONFIG-RENDERED"],
                      ),
                      h.h2(
                        [h.Class("mt-4 text-2xl font-bold tracking-tight text-slate-950")],
                        [selected.title],
                      ),
                      h.p(
                        [h.Class("mt-2 text-sm leading-6 text-slate-500")],
                        [selected.description],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("space-y-6")],
                    selected.fields.map((field) =>
                      h.div(
                        [],
                        [
                          h.p(
                            [h.Class("text-sm font-semibold text-slate-900")],
                            [
                              field.label,
                              field.required
                                ? h.span([h.Class("ml-1 text-rose-500")], ["*"])
                                : h.empty,
                            ],
                          ),
                          h.p([h.Class("mt-1 mb-2 text-xs text-slate-500")], [field.description]),
                          field.input === "textarea"
                            ? Textarea.view(
                                {
                                  id: `form-${field.name}`,
                                  value: model.formValues[field.name] ?? "",
                                  rows: 4,
                                  onInput: (value) =>
                                    Message.ChangedFormField({ field: field.name, value }),
                                  toView: ({ textarea }) =>
                                    h.textarea([
                                      ...textarea,
                                      h.Class(
                                        "block w-full resize-y rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-900 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50",
                                      ),
                                    ]),
                                },
                                h,
                              )
                            : field.input === "select"
                              ? Select.view(
                                  {
                                    id: `form-${field.name}`,
                                    value: model.formValues[field.name] ?? "",
                                    onChange: (value) =>
                                      Message.ChangedFormField({ field: field.name, value }),
                                    toView: ({ select }) =>
                                      h.select(
                                        [
                                          ...select,
                                          h.Class(
                                            "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50",
                                          ),
                                        ],
                                        [
                                          h.option([h.Value("")], ["Choose an answer…"]),
                                          ...field.options.map((option) =>
                                            h.option([h.Value(option)], [option]),
                                          ),
                                        ],
                                      ),
                                  },
                                  h,
                                )
                              : Input.view(
                                  {
                                    id: `form-${field.name}`,
                                    value: model.formValues[field.name] ?? "",
                                    onInput: (value) =>
                                      Message.ChangedFormField({ field: field.name, value }),
                                    toView: ({ input }) =>
                                      h.input([
                                        ...input,
                                        h.Class(
                                          "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50",
                                        ),
                                      ]),
                                  },
                                  h,
                                ),
                        ],
                      ),
                    ),
                  ),
                  h.div(
                    [
                      h.Class(
                        "mt-8 flex items-center justify-between border-t border-slate-100 pt-6",
                      ),
                    ],
                    [
                      h.p(
                        [h.Class("text-xs text-slate-400")],
                        ["Preview only · no host command attached"],
                      ),
                      uiButton(selected.submitLabel, Message.RequestedValidateForm(), h, {
                        kind: "primary",
                      }),
                    ],
                  ),
                ],
              ),
        ],
      ),
    ],
  );
};

const queryView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const result = model.queryResult;
  return h.div(
    [],
    [
      pageHeader(
        "Query workbench",
        "Ask the graph",
        "Edit and execute raw Datalog against the same in-memory Triplex service used by every other view.",
        model,
        h,
      ),
      h.div(
        [h.Class("grid gap-6 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]")],
        [
          h.section(
            [
              h.Class(
                "overflow-hidden rounded-2xl border border-slate-200/80 bg-[#101827] shadow-[0_12px_35px_rgba(15,23,42,0.14)]",
              ),
            ],
            [
              h.div(
                [
                  h.Class(
                    "flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between",
                  ),
                ],
                [
                  h.div(
                    [],
                    [
                      h.h2([h.Class("text-sm font-bold text-white")], ["Datalog query"]),
                      h.p(
                        [h.Class("mt-0.5 text-xs text-slate-400")],
                        ["JSON syntax · shared temporal basis"],
                      ),
                    ],
                  ),
                  Select.view(
                    {
                      id: "query-preset",
                      value: model.queryPreset,
                      onChange: (preset) => Message.SelectedQueryPreset({ preset }),
                      toView: ({ select }) =>
                        h.select(
                          [
                            ...select,
                            h.Class(
                              "h-9 rounded-lg border border-white/10 bg-white/8 px-3 text-xs font-semibold text-slate-200 outline-none focus:border-blue-400",
                            ),
                          ],
                          [
                            ...queryPresets.map((preset) =>
                              h.option([h.Value(preset.id)], [preset.label]),
                            ),
                            ...(model.queryPreset === "custom"
                              ? [h.option([h.Value("custom")], ["Custom query"])]
                              : []),
                          ],
                        ),
                    },
                    h,
                  ),
                ],
              ),
              Textarea.view(
                {
                  id: "datalog-source",
                  value: model.queryText,
                  rows: 21,
                  onInput: (value) => Message.ChangedQueryText({ value }),
                  toView: ({ textarea }) =>
                    h.textarea([
                      ...textarea,
                      h.Class(
                        "block min-h-[430px] w-full resize-y bg-transparent p-5 font-mono text-[13px] leading-6 text-blue-100 outline-none selection:bg-blue-400/30",
                      ),
                    ]),
                },
                h,
              ),
              h.div(
                [h.Class("flex items-center justify-between border-t border-white/10 px-5 py-4")],
                [
                  h.span([h.Class("text-[11px] text-slate-500")], ["Cmd/Ctrl + Enter coming next"]),
                  uiButton(model.busy ? "Running…" : "Run query", Message.RequestedQuery(), h, {
                    kind: "primary",
                    disabled: model.busy,
                    icon: "query",
                  }),
                ],
              ),
            ],
          ),
          h.section(
            [
              h.Class(
                "min-w-0 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]",
              ),
            ],
            [
              h.div(
                [h.Class("flex items-center justify-between border-b border-slate-100 px-5 py-4")],
                [
                  h.div(
                    [],
                    [
                      h.h2([h.Class("text-sm font-bold text-slate-900")], ["Results"]),
                      h.p(
                        [h.Class("mt-0.5 text-xs text-slate-500")],
                        [
                          result === null
                            ? "Run a query to inspect bindings"
                            : `${result.resultCount} bindings in ${result.executionTimeMs.toFixed(2)} ms`,
                        ],
                      ),
                    ],
                  ),
                  result === null
                    ? h.empty
                    : h.span(
                        [
                          h.Class(
                            "rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700",
                          ),
                        ],
                        ["Executed"],
                      ),
                ],
              ),
              result === null
                ? h.div(
                    [
                      h.Class(
                        "flex min-h-[360px] flex-col items-center justify-center p-10 text-center",
                      ),
                    ],
                    [
                      h.div(
                        [
                          h.Class(
                            "mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-600",
                          ),
                        ],
                        [icon("query", h)],
                      ),
                      h.p(
                        [h.Class("text-sm font-semibold text-slate-700")],
                        ["No query result yet"],
                      ),
                      h.p(
                        [h.Class("mt-1 max-w-xs text-xs leading-5 text-slate-400")],
                        ["Choose a preset or edit the query, then execute it against Triplex."],
                      ),
                    ],
                  )
                : h.div(
                    [],
                    [
                      h.div(
                        [h.Class("max-h-[410px] overflow-auto")],
                        [
                          h.table(
                            [h.Class("w-full text-left text-sm")],
                            [
                              h.thead(
                                [
                                  h.Class(
                                    "sticky top-0 bg-slate-50 text-[10px] font-bold tracking-[0.12em] text-slate-400 uppercase",
                                  ),
                                ],
                                [
                                  h.tr(
                                    [],
                                    result.columns.map((column) =>
                                      h.th([h.Class("whitespace-nowrap px-4 py-3")], [column]),
                                    ),
                                  ),
                                ],
                              ),
                              h.tbody(
                                [h.Class("divide-y divide-slate-100")],
                                result.rows.map((row) =>
                                  h.tr(
                                    [h.Class("hover:bg-blue-50/30")],
                                    row.map((cell) =>
                                      h.td(
                                        [
                                          h.Class(
                                            "whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-700",
                                          ),
                                        ],
                                        [cell],
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("border-t border-slate-100 bg-slate-50/60 p-5")],
                        [
                          h.p(
                            [
                              h.Class(
                                "mb-2 text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase",
                              ),
                            ],
                            ["Execution plan"],
                          ),
                          ...(result.plan.length === 0
                            ? [
                                h.p(
                                  [h.Class("text-xs text-slate-500")],
                                  ["The backend returned no plan steps."],
                                ),
                              ]
                            : result.plan.map((step) =>
                                h.code(
                                  [
                                    h.Class(
                                      "block overflow-x-auto whitespace-pre text-[10px] leading-5 text-slate-500",
                                    ),
                                  ],
                                  [step],
                                ),
                              )),
                        ],
                      ),
                    ],
                  ),
            ],
          ),
        ],
      ),
    ],
  );
};

const journalView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const data = model.data!;
  return h.div(
    [],
    [
      pageHeader(
        "Causal history",
        "Transaction journal",
        "Every fact transition retains who acted, which command caused it, the pinned configuration, and the complete typed changes.",
        model,
        h,
      ),
      h.div(
        [h.Class("mb-5 flex flex-wrap items-center gap-2 text-xs")],
        [
          h.span(
            [
              h.Class(
                "rounded-full bg-white px-3 py-1.5 font-semibold text-slate-600 ring-1 ring-slate-200",
              ),
            ],
            [`${data.transactions.length} commits`],
          ),
          h.span(
            [
              h.Class(
                "rounded-full bg-white px-3 py-1.5 font-semibold text-slate-600 ring-1 ring-slate-200",
              ),
            ],
            [`snapshot position ${data.position}`],
          ),
          h.span(
            [
              h.Class(
                "rounded-full bg-blue-50 px-3 py-1.5 font-semibold text-blue-700 ring-1 ring-blue-100",
              ),
            ],
            ["newest first"],
          ),
        ],
      ),
      h.div(
        [h.Class("space-y-4")],
        data.transactions.map((transaction) =>
          h.article(
            [
              h.Class(
                "rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]",
              ),
            ],
            [
              h.div(
                [h.Class("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between")],
                [
                  h.div(
                    [h.Class("flex min-w-0 gap-3")],
                    [
                      h.div(
                        [
                          h.Class(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600",
                          ),
                        ],
                        [icon("journal", h)],
                      ),
                      h.div(
                        [h.Class("min-w-0")],
                        [
                          h.div(
                            [h.Class("flex flex-wrap items-center gap-2")],
                            [
                              h.h2(
                                [h.Class("text-sm font-bold text-slate-900")],
                                [transaction.actor ?? "Triplex system"],
                              ),
                              h.span(
                                [
                                  h.Class(
                                    "rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500",
                                  ),
                                ],
                                [`position ${transaction.position}`],
                              ),
                            ],
                          ),
                          h.p(
                            [h.Class("mt-1 truncate font-mono text-[11px] text-slate-400")],
                            [transaction.commandId ?? transaction.id],
                          ),
                        ],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("shrink-0 text-left sm:text-right")],
                    [
                      h.p(
                        [h.Class("text-xs font-semibold text-slate-700")],
                        [formatInstant(transaction.instant)],
                      ),
                      h.p(
                        [h.Class("mt-1 text-[10px] text-slate-400")],
                        [`${transaction.changes.length} fact changes`],
                      ),
                    ],
                  ),
                ],
              ),
              h.div(
                [h.Class("mt-4 grid gap-2")],
                [
                  ...transaction.changes
                    .slice(0, 5)
                    .map((change) =>
                      h.div(
                        [
                          h.Class(
                            "grid gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs sm:grid-cols-[62px_minmax(120px,0.8fr)_minmax(150px,1fr)_minmax(100px,0.7fr)]",
                          ),
                        ],
                        [
                          h.span(
                            [
                              h.Class(
                                change.op === "assert"
                                  ? "font-bold text-emerald-700"
                                  : "font-bold text-rose-700",
                              ),
                            ],
                            [change.op],
                          ),
                          h.code([h.Class("truncate text-slate-500")], [change.entityId]),
                          h.code(
                            [h.Class("truncate font-semibold text-blue-700")],
                            [change.attribute],
                          ),
                          h.span([h.Class("truncate text-slate-600")], [change.value]),
                        ],
                      ),
                    ),
                  ...(transaction.changes.length > 5
                    ? [
                        h.p(
                          [h.Class("px-3 pt-1 text-xs font-medium text-slate-400")],
                          [
                            `+ ${transaction.changes.length - 5} more changes in this atomic commit`,
                          ],
                        ),
                      ]
                    : []),
                ],
              ),
              h.div(
                [
                  h.Class(
                    "mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-slate-100 pt-4 font-mono text-[10px] text-slate-400",
                  ),
                ],
                [
                  h.span([], [`tx ${shortId(transaction.id)}`]),
                  ...(transaction.correlationId === null
                    ? []
                    : [h.span([], [`correlation ${shortId(transaction.correlationId)}`])]),
                  ...(transaction.configSnapshot === null
                    ? []
                    : [h.span([], [`config ${shortId(transaction.configSnapshot)}`])]),
                ],
              ),
            ],
          ),
        ),
      ),
    ],
  );
};

const configView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const config = model.data!.config;
  const selected =
    config.objects.find(
      (object) => `${object.kind}\u0000${object.key}` === model.selectedConfigObject,
    ) ?? config.objects[0];
  return h.div(
    [],
    [
      pageHeader(
        "Release graph",
        "Configuration",
        "A release pins immutable typed nodes and their dependency closures. Only refs move.",
        model,
        h,
      ),
      h.section(
        [
          h.Class(
            "mb-6 overflow-hidden rounded-2xl bg-[#101827] text-white shadow-[0_14px_35px_rgba(15,23,42,0.16)]",
          ),
        ],
        [
          h.div(
            [h.Class("grid gap-6 p-6 lg:grid-cols-[1fr_auto]")],
            [
              h.div(
                [],
                [
                  h.div(
                    [
                      h.Class(
                        "mb-3 flex items-center gap-2 text-xs font-bold tracking-[0.15em] text-blue-300 uppercase",
                      ),
                    ],
                    [icon("config", h), "Active release"],
                  ),
                  h.h2([h.Class("text-2xl font-bold tracking-tight")], [config.label]),
                  h.p(
                    [h.Class("mt-2 max-w-2xl text-sm leading-6 text-slate-400")],
                    [
                      "This exact root identifies the data, projection schemas, and transitive dependency closures used by the running example.",
                    ],
                  ),
                ],
              ),
              h.div(
                [h.Class("grid grid-cols-3 gap-2")],
                [
                  ["objects", config.objectCount],
                  ["revisions", config.revisionCount],
                  ["releases", config.releaseCount],
                ].map(([label, value]) =>
                  h.div(
                    [h.Class("min-w-22 rounded-xl bg-white/7 p-3 text-center ring-1 ring-white/8")],
                    [
                      h.p([h.Class("text-xl font-bold")], [String(value)]),
                      h.p(
                        [
                          h.Class(
                            "mt-1 text-[10px] font-bold tracking-wide text-slate-500 uppercase",
                          ),
                        ],
                        [String(label)],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          h.div(
            [h.Class("grid border-t border-white/8 lg:grid-cols-2")],
            [
              h.div(
                [h.Class("border-b border-white/8 p-5 lg:border-r lg:border-b-0")],
                [
                  h.p(
                    [
                      h.Class(
                        "mb-2 text-[10px] font-bold tracking-[0.14em] text-slate-500 uppercase",
                      ),
                    ],
                    ["Snapshot id"],
                  ),
                  h.code(
                    [h.Class("block break-all text-[11px] leading-5 text-blue-200")],
                    [config.snapshotId],
                  ),
                ],
              ),
              h.div(
                [h.Class("p-5")],
                [
                  h.p(
                    [
                      h.Class(
                        "mb-2 text-[10px] font-bold tracking-[0.14em] text-slate-500 uppercase",
                      ),
                    ],
                    ["Root content id"],
                  ),
                  h.code(
                    [h.Class("block break-all text-[11px] leading-5 text-violet-200")],
                    [config.rootContentId],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("mb-6 grid gap-4 sm:grid-cols-2")],
        config.refs.map((item) =>
          h.div(
            [
              h.Class(
                "flex items-center gap-4 rounded-2xl border border-slate-200/80 bg-white p-5",
              ),
            ],
            [
              h.div(
                [
                  h.Class(
                    "flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600",
                  ),
                ],
                [icon("arrow", h)],
              ),
              h.div(
                [h.Class("min-w-0")],
                [
                  h.div(
                    [h.Class("flex items-center gap-2")],
                    [
                      h.h3([h.Class("font-bold text-slate-900")], [item.name]),
                      h.span(
                        [
                          h.Class(
                            "rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700",
                          ),
                        ],
                        ["moving ref"],
                      ),
                    ],
                  ),
                  h.code(
                    [h.Class("mt-1 block truncate text-[10px] text-slate-400")],
                    [item.snapshotId],
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
      h.div(
        [h.Class("grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]")],
        [
          h.section(
            [h.Class("overflow-hidden rounded-2xl border border-slate-200 bg-white")],
            [
              h.div(
                [h.Class("border-b border-slate-100 px-5 py-4")],
                [
                  h.h2([h.Class("text-sm font-bold text-slate-900")], ["Logical objects"]),
                  h.p(
                    [h.Class("mt-0.5 text-xs text-slate-500")],
                    [`${config.objects.length} identities across all releases`],
                  ),
                ],
              ),
              h.div(
                [h.Class("max-h-[760px] divide-y divide-slate-100 overflow-y-auto")],
                config.objects.map((object) => {
                  const identity = `${object.kind}\u0000${object.key}`;
                  return Button.view(
                    {
                      onClick: Message.SelectedConfigObject({ object: identity }),
                      toView: ({ button }) =>
                        h.button(
                          [
                            ...button,
                            h.Class(
                              `block w-full p-4 text-left ${identity === model.selectedConfigObject ? "bg-blue-50/70" : "hover:bg-slate-50"}`,
                            ),
                          ],
                          [
                            h.div(
                              [h.Class("mb-2 flex items-center justify-between gap-2")],
                              [
                                h.span(
                                  [
                                    h.Class(
                                      "rounded-md bg-slate-100 px-2 py-1 text-[9px] font-bold tracking-wide text-slate-600 uppercase",
                                    ),
                                  ],
                                  [object.kind],
                                ),
                                h.span(
                                  [
                                    h.Class(
                                      object.active
                                        ? "text-[10px] font-bold text-emerald-600"
                                        : "text-[10px] font-bold text-slate-400",
                                    ),
                                  ],
                                  [object.active ? "ACTIVE" : "HISTORICAL"],
                                ),
                              ],
                            ),
                            h.p(
                              [h.Class("truncate font-mono text-xs font-semibold text-slate-900")],
                              [object.key],
                            ),
                            h.p(
                              [h.Class("mt-1 text-[10px] text-slate-400")],
                              [
                                `${object.history.length} version${object.history.length === 1 ? "" : "s"}`,
                              ],
                            ),
                          ],
                        ),
                    },
                    h,
                  );
                }),
              ),
            ],
          ),
          selected === undefined
            ? h.section(
                [
                  h.Class(
                    "rounded-2xl border border-slate-200 bg-white p-10 text-sm text-slate-400",
                  ),
                ],
                ["No configuration objects have been committed."],
              )
            : h.div(
                [h.Class("space-y-6")],
                [
                  h.section(
                    [h.Class("rounded-2xl border border-slate-200 bg-white p-6")],
                    [
                      h.div(
                        [h.Class("flex flex-wrap items-start justify-between gap-4")],
                        [
                          h.div(
                            [],
                            [
                              h.p(
                                [
                                  h.Class(
                                    "text-[10px] font-bold tracking-[0.14em] text-blue-600 uppercase",
                                  ),
                                ],
                                [selected.kind],
                              ),
                              h.h2(
                                [h.Class("mt-1 font-mono text-lg font-bold text-slate-950")],
                                [selected.key],
                              ),
                            ],
                          ),
                          h.span(
                            [
                              h.Class(
                                "rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700",
                              ),
                            ],
                            [
                              `${selected.history.length} immutable version${selected.history.length === 1 ? "" : "s"}`,
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("mt-5 grid gap-4 sm:grid-cols-2")],
                        [
                          h.div(
                            [],
                            [
                              h.p(
                                [
                                  h.Class(
                                    "text-[9px] font-bold tracking-wide text-slate-400 uppercase",
                                  ),
                                ],
                                ["Current revision"],
                              ),
                              h.code(
                                [h.Class("mt-1 block break-all text-[10px] text-slate-600")],
                                [selected.revisionId],
                              ),
                            ],
                          ),
                          h.div(
                            [],
                            [
                              h.p(
                                [
                                  h.Class(
                                    "text-[9px] font-bold tracking-wide text-slate-400 uppercase",
                                  ),
                                ],
                                ["Current content"],
                              ),
                              h.code(
                                [h.Class("mt-1 block break-all text-[10px] text-slate-600")],
                                [selected.contentId],
                              ),
                            ],
                          ),
                        ],
                      ),
                      ...(selected.dependencies.length === 0
                        ? []
                        : [
                            h.div(
                              [h.Class("mt-5 flex flex-wrap gap-2")],
                              selected.dependencies.map((dependency) =>
                                h.span(
                                  [
                                    h.Class(
                                      "rounded-md bg-slate-100 px-2 py-1 font-mono text-[10px] text-slate-600",
                                    ),
                                  ],
                                  [dependency],
                                ),
                              ),
                            ),
                          ]),
                    ],
                  ),
                  h.section(
                    [h.Class("overflow-hidden rounded-2xl border border-slate-200 bg-white")],
                    [
                      h.div(
                        [h.Class("border-b border-slate-100 px-5 py-4")],
                        [
                          h.h2([h.Class("text-sm font-bold text-slate-900")], ["Revision history"]),
                          h.p(
                            [h.Class("mt-0.5 text-xs text-slate-500")],
                            ["Newest first · bodies are canonical stored configuration"],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("divide-y divide-slate-100")],
                        selected.history.map((revision, index) =>
                          h.article(
                            [h.Class("p-5")],
                            [
                              h.div(
                                [h.Class("flex flex-wrap items-center justify-between gap-3")],
                                [
                                  h.div(
                                    [h.Class("flex items-center gap-2")],
                                    [
                                      h.span(
                                        [
                                          h.Class(
                                            "rounded-md bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-700",
                                          ),
                                        ],
                                        [`v${revision.sequence}`],
                                      ),
                                      ...(index === 0
                                        ? [
                                            h.span(
                                              [h.Class("text-[10px] font-bold text-emerald-600")],
                                              ["LATEST"],
                                            ),
                                          ]
                                        : []),
                                    ],
                                  ),
                                  h.div(
                                    [h.Class("flex flex-wrap gap-1.5")],
                                    revision.releases.map((release) =>
                                      h.span(
                                        [
                                          h.Class(
                                            "rounded-full bg-slate-100 px-2 py-1 text-[9px] font-semibold text-slate-600",
                                          ),
                                        ],
                                        [release],
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              h.div(
                                [h.Class("mt-4 grid gap-3 md:grid-cols-2")],
                                [
                                  h.div(
                                    [],
                                    [
                                      h.p(
                                        [h.Class("text-[9px] font-bold text-slate-400 uppercase")],
                                        ["Revision / parent"],
                                      ),
                                      h.code(
                                        [
                                          h.Class(
                                            "mt-1 block break-all text-[10px] leading-5 text-slate-500",
                                          ),
                                        ],
                                        [revision.revisionId],
                                      ),
                                      h.code(
                                        [
                                          h.Class(
                                            "block break-all text-[10px] leading-5 text-slate-400",
                                          ),
                                        ],
                                        [revision.parentRevisionId ?? "root"],
                                      ),
                                    ],
                                  ),
                                  h.div(
                                    [],
                                    [
                                      h.p(
                                        [h.Class("text-[9px] font-bold text-slate-400 uppercase")],
                                        ["Content / closure"],
                                      ),
                                      h.code(
                                        [
                                          h.Class(
                                            "mt-1 block break-all text-[10px] leading-5 text-slate-500",
                                          ),
                                        ],
                                        [revision.contentId],
                                      ),
                                      h.code(
                                        [
                                          h.Class(
                                            "block break-all text-[10px] leading-5 text-slate-400",
                                          ),
                                        ],
                                        [revision.closureContentId],
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                              h.pre(
                                [
                                  h.Class(
                                    "mt-4 max-h-80 overflow-auto rounded-xl bg-[#101827] p-4 font-mono text-[11px] leading-5 text-slate-300",
                                  ),
                                ],
                                [revision.body],
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
        ],
      ),
      h.section(
        [h.Class("mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white")],
        [
          h.div(
            [h.Class("border-b border-slate-100 px-5 py-4")],
            [
              h.h2([h.Class("text-sm font-bold text-slate-900")], ["Release history"]),
              h.p(
                [h.Class("mt-0.5 text-xs text-slate-500")],
                ["Immutable roots and the refs currently pointing at them"],
              ),
            ],
          ),
          h.div(
            [h.Class("divide-y divide-slate-100")],
            config.releases.map((release) =>
              h.article(
                [h.Class("grid gap-3 p-5 md:grid-cols-[90px_1fr_auto]")],
                [
                  h.div(
                    [],
                    [
                      h.p(
                        [h.Class("text-xs font-bold text-slate-900")],
                        [`release ${release.sequence}`],
                      ),
                      h.p(
                        [h.Class("mt-1 text-[10px] text-slate-400")],
                        [`${release.revisionCount} revisions`],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("min-w-0")],
                    [
                      h.p([h.Class("text-sm font-semibold text-slate-900")], [release.label]),
                      h.code(
                        [h.Class("mt-1 block truncate text-[10px] text-slate-500")],
                        [release.snapshotId],
                      ),
                      h.code(
                        [h.Class("block truncate text-[10px] text-slate-400")],
                        [`root ${release.rootContentId}`],
                      ),
                      h.code(
                        [h.Class("block truncate text-[10px] text-slate-400")],
                        [`parent ${release.parentSnapshotId ?? "root"}`],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("flex flex-wrap items-start justify-end gap-2")],
                    release.refs.map((refName) =>
                      h.span(
                        [
                          h.Class(
                            "rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-700",
                          ),
                        ],
                        [refName],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  );
};

const content = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.data === null) {
    return h.div(
      [h.Class("flex min-h-[70vh] flex-col items-center justify-center text-center")],
      [
        h.div(
          [
            h.Class(
              "mb-5 flex h-16 w-16 animate-pulse items-center justify-center rounded-2xl bg-blue-50 text-blue-600",
            ),
          ],
          [icon("database", h)],
        ),
        h.h1([h.Class("text-xl font-bold text-slate-900")], ["Building the example database"]),
        h.p(
          [h.Class("mt-2 max-w-md text-sm leading-6 text-slate-500")],
          [
            "Publishing a typed config release, recording facts, and evaluating the first Datalog derivation.",
          ],
        ),
      ],
    );
  }
  switch (model.page) {
    case "overview":
      return overviewView(model, h);
    case "entities":
      return entitiesView(model, h);
    case "forms":
      return formsView(model, h);
    case "query":
      return queryView(model, h);
    case "journal":
      return journalView(model, h);
    case "config":
      return configView(model, h);
  }
};

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `${navItems.find((item) => item.page === model.page)?.label ?? "Explorer"} | Triplex`,
  lang: "en",
  body: h.div(
    [h.Class("min-h-screen bg-[#f4f7fb] text-slate-800")],
    [
      sidebar(model, h),
      h.main(
        [h.Class("lg:pl-68")],
        [
          h.div(
            [h.Class("mx-auto max-w-[1480px] px-4 py-7 sm:px-7 lg:px-9 lg:py-9")],
            [
              ...(model.error === null
                ? []
                : [
                    h.div(
                      [
                        h.Class(
                          "mb-5 flex items-start justify-between gap-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800",
                        ),
                      ],
                      [
                        h.p([h.Class("leading-5")], [model.error]),
                        uiButton("Try again", Message.RequestedRefresh(), h, {
                          kind: "quiet",
                          disabled: model.busy,
                        }),
                      ],
                    ),
                  ]),
              ...(model.notice === null
                ? []
                : [
                    h.div(
                      [
                        h.Class(
                          "mb-5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800",
                        ),
                      ],
                      [model.notice],
                    ),
                  ]),
              content(model, h),
            ],
          ),
        ],
      ),
    ],
  ),
});
