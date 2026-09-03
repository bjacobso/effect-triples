import {
  DatalogQuery,
  Triples,
  type DatalogQuery as DatalogQueryType,
  type TransactionRecord,
  type Triple,
  type TripleValue,
} from "@bjacobso/triplex";
import { ConfigStore, InMemoryConfigStore } from "@bjacobso/triplex/config";
import * as Derivation from "@bjacobso/triplex/derivation";
import { Effect, Option, Schema } from "effect";
import type {
  ConfigObjectView,
  DashboardData,
  EntityView,
  EntityTypePageView,
  FormView,
  QueryView,
  TransactionView,
} from "./model.js";

export const queryPresets = [
  {
    id: "all-facts",
    label: "All facts",
    query: {
      find: ["?entity", "?attribute", "?value"],
      where: [["?entity", "?attribute", "?value"]],
      orderBy: [
        { variable: "?entity", direction: "asc" },
        { variable: "?attribute", direction: "asc" },
      ],
      limit: 100,
    },
  },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly query: DatalogQueryType;
}>;

export const initialQueryText = JSON.stringify(queryPresets[0].query, null, 2);

const EntityTypeCursor = Schema.Struct({
  version: Schema.Literal(1),
  entityType: Schema.String,
  recordedAt: Schema.Number,
  validAt: Schema.Number,
  afterEntityId: Schema.NullOr(Schema.String),
});

const encodeCursor = (cursor: typeof EntityTypeCursor.Type): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const decodeCursor = (cursor: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => {
        const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      },
      catch: (cause) => new Error(`Invalid entity page cursor: ${String(cause)}`),
    });
    return yield* Schema.decodeUnknownEffect(EntityTypeCursor)(parsed);
  });

const optionOrNull = <A>(value: Option.Option<A>): A | null => Option.getOrNull(value);

const valueText = (value: TripleValue | undefined): string => {
  if (value === undefined) return "—";
  switch (value.type) {
    case "boolean":
    case "number":
    case "ref":
    case "string":
      return String(value.value);
    case "datetime":
      return new Date(value.value).toLocaleString();
    case "json":
      return JSON.stringify(value.value);
    case "blob":
      return `${value.filename ?? "blob"} · ${value.mimeType} · ${value.size} bytes`;
  }
};

const valueTextFromConstant = (value: unknown): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object" && "type" in value && value.type === "ref" && "value" in value) {
    return String(value.value);
  }
  return String(value);
};

const isApplicationFact = (triple: Triple): boolean =>
  !triple.entityId.startsWith("_triplex/") && !triple.entityId.startsWith("_tx/");

/**
 * Entity labels are presentation hints only. The inspector prefers conventional
 * name/title/label attributes, then any text value, and finally the entity id.
 */
const reflectedLabel = (id: string, facts: readonly Triple[]): string => {
  const strings = facts.filter((fact) => fact.value.type === "string");
  const preferred = strings
    .filter((fact) => /\/(name|title|label)$/.test(fact.attribute))
    .sort((left, right) => left.attribute.localeCompare(right.attribute))[0];
  const fallback = strings.sort((left, right) => left.attribute.localeCompare(right.attribute))[0];
  return valueText(preferred?.value ?? fallback?.value) || id;
};

const entitiesFrom = (facts: readonly Triple[]): readonly EntityView[] => {
  const grouped = new Map<string, Triple[]>();
  for (const fact of facts.filter(isApplicationFact)) {
    const current = grouped.get(fact.entityId) ?? [];
    current.push(fact);
    grouped.set(fact.entityId, current);
  }
  return [...grouped.entries()]
    .map(([id, rows]) => ({
      id,
      type: optionOrNull(rows[0]!.entityType) ?? "Entity",
      name: reflectedLabel(id, rows),
      facts: [...rows]
        .sort((left, right) => left.attribute.localeCompare(right.attribute))
        .map((fact) => ({
          id: fact.id,
          attribute: fact.attribute,
          value: valueText(fact.value),
          valueType: fact.value.type,
          validFrom: fact.validFrom,
          validTo: optionOrNull(fact.validTo),
          recordedAt: fact.recordedAt,
          txId: optionOrNull(fact.txId),
        })),
    }))
    .sort(
      (left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name),
    );
};

export const loadEntityTypePage = (
  entityType: string,
  cursor: string | null,
  pageSize = 5,
): Effect.Effect<EntityTypePageView, unknown, Triples> =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const now = Date.now();
    const decoded =
      cursor === null
        ? { version: 1 as const, entityType, recordedAt: now, validAt: now, afterEntityId: null }
        : yield* decodeCursor(cursor);
    if (decoded.entityType !== entityType) {
      return yield* Effect.fail(new Error("Entity page cursor belongs to a different entity type"));
    }
    if (pageSize < 1 || pageSize > 100 || !Number.isInteger(pageSize)) {
      return yield* Effect.fail(new Error("Entity page size must be an integer between 1 and 100"));
    }
    const basis = { recordedAt: decoded.recordedAt, validAt: decoded.validAt };
    const typeFacts = yield* triples.match({ entityType }, basis);
    const entityIds = [...new Set(typeFacts.map((fact) => fact.entityId))].sort();
    const start =
      decoded.afterEntityId === null ? 0 : entityIds.findIndex((id) => id > decoded.afterEntityId!);
    const normalizedStart = start < 0 ? entityIds.length : start;
    const pageIds = entityIds.slice(normalizedStart, normalizedStart + pageSize);
    const rows = yield* triples.entities(pageIds, basis);
    const entities = entitiesFrom(rows.flat());
    const columns = [...new Set(typeFacts.map((fact) => fact.attribute))].sort();
    const hasNext = normalizedStart + pageIds.length < entityIds.length;
    return {
      entityType,
      columns,
      entities,
      totalCount: entityIds.length,
      nextCursor:
        hasNext && pageIds.length > 0
          ? encodeCursor({ ...decoded, afterEntityId: pageIds.at(-1)! })
          : null,
    };
  });

const transactionView = (transaction: TransactionRecord): TransactionView => ({
  id: transaction.txId,
  position: transaction.position,
  instant: transaction.instant,
  actor: transaction.actor ?? null,
  commandId: transaction.commandId ?? null,
  correlationId: transaction.correlationId ?? null,
  configSnapshot: transaction.configSnapshot ?? null,
  changes: transaction.changes.map((change) => ({
    op: change.op,
    entityId: change.entityId,
    attribute: change.attribute,
    value: valueText(change.value),
  })),
});

const configObjectViews = (
  store: InMemoryConfigStore.InMemoryConfigStore,
  snapshot: InMemoryConfigStore.ConfigSnapshot | undefined,
): readonly ConfigObjectView[] =>
  [
    ...new Map(
      store.revisions.map((revision) => [
        `${revision.kind}\u0000${revision.key}`,
        {
          kind: revision.kind,
          key: revision.key,
        },
      ]),
    ).values(),
  ]
    .flatMap((identity) => {
      const history = store.revisions
        .filter((item) => item.kind === identity.kind && item.key === identity.key)
        .sort((left, right) => right.seq - left.seq || right.id.localeCompare(left.id));
      const activeRevision = history.find(
        (revision) => snapshot?.revisionIds.includes(revision.id) ?? false,
      );
      const revision = activeRevision ?? history[0];
      if (revision === undefined) return [];
      return [
        {
          kind: revision.kind,
          key: revision.key,
          active: activeRevision !== undefined,
          revisionId: revision.id,
          contentId: revision.cid,
          dependencies: revision.deps.map((dependency) => `${dependency.kind}/${dependency.key}`),
          history: history.map((item) => ({
            revisionId: item.id,
            sequence: item.seq,
            contentId: item.cid,
            closureContentId: item.closureCid,
            parentRevisionId: item.parentId,
            body: JSON.stringify(store.objects.get(item.cid)?.body ?? null, null, 2),
            releases: store.snapshots
              .filter((candidate) => candidate.revisionIds.includes(item.id))
              .map((candidate) => candidate.label),
          })),
        },
      ];
    })
    .sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key),
    );

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const configuredForms = (
  store: InMemoryConfigStore.InMemoryConfigStore,
  snapshot: InMemoryConfigStore.ConfigSnapshot | undefined,
): readonly FormView[] =>
  (snapshot?.revisionIds ?? []).flatMap((revisionId) => {
    const revision = store.revisions.find((item) => item.id === revisionId);
    if (revision?.kind !== "form") return [];
    const body = asRecord(store.objects.get(revision.cid)?.body);
    const attrs = asRecord(body?.["attrs"]);
    if (
      attrs?.["renderer"] !== "triplex.form/v1" ||
      typeof attrs["title"] !== "string" ||
      typeof attrs["description"] !== "string" ||
      typeof attrs["submitLabel"] !== "string"
    )
      return [];
    const fields = (Array.isArray(body?.["children"]) ? body["children"] : []).flatMap((child) => {
      const edge = asRecord(child);
      if (edge?.["rel"] !== "field" || typeof edge["cid"] !== "string") return [];
      const fieldObject = [...store.objects.entries()].find(([cid]) => cid === edge["cid"])?.[1];
      const fieldBody = asRecord(fieldObject?.body);
      const fieldAttrs = asRecord(fieldBody?.["attrs"]);
      const input = fieldAttrs?.["input"];
      const options = fieldAttrs?.["options"];
      if (
        typeof fieldBody?.["key"] !== "string" ||
        typeof fieldAttrs?.["name"] !== "string" ||
        typeof fieldAttrs["label"] !== "string" ||
        typeof fieldAttrs["description"] !== "string" ||
        (input !== "text" && input !== "textarea" && input !== "select") ||
        typeof fieldAttrs["required"] !== "boolean" ||
        !Array.isArray(options) ||
        !options.every((option) => typeof option === "string")
      )
        return [];
      return [
        {
          key: fieldBody["key"],
          name: fieldAttrs["name"],
          label: fieldAttrs["label"],
          description: fieldAttrs["description"],
          input: input as "text" | "textarea" | "select",
          required: fieldAttrs["required"],
          options,
        },
      ];
    });
    return [
      {
        key: revision.key,
        title: attrs["title"],
        description: attrs["description"],
        submitLabel: attrs["submitLabel"],
        fields,
      },
    ];
  });

/** Discover executable derivations from the selected configuration snapshot. */
export const configuredDerivations = (
  store: InMemoryConfigStore.InMemoryConfigStore,
  snapshot: InMemoryConfigStore.ConfigSnapshot | undefined,
) =>
  Effect.forEach(
    snapshot?.revisionIds ?? [],
    (revisionId) =>
      Effect.gen(function* () {
        const revision = store.revisions.find((item) => item.id === revisionId);
        if (revision?.kind !== "derivation" || snapshot === undefined) return undefined;
        const body = asRecord(store.objects.get(revision.cid)?.body);
        const attrs = asRecord(body?.["attrs"]);
        const identity = attrs?.["identity"];
        if (!Array.isArray(identity) || !identity.every((item) => typeof item === "string")) {
          return undefined;
        }
        const query = yield* Schema.decodeUnknownEffect(DatalogQuery)(attrs?.["query"]);
        return yield* Derivation.make({
          name: revision.key,
          query,
          identity,
          configSnapshot: snapshot.id,
        });
      }),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)));

export const executeQueryText = (source: string): Effect.Effect<QueryView, unknown, Triples> =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      catch: (cause) => cause,
    });
    const query = yield* Schema.decodeUnknownEffect(DatalogQuery)(parsed);
    const started = performance.now();
    const [response, explanation] = yield* Effect.all([
      triples.query(query, { debug: true }),
      triples.explain(query),
    ]);
    const elapsed = response.debug?.executionTimeMs ?? performance.now() - started;
    const columns = [
      ...new Set([
        ...query.find.filter((item): item is string => typeof item === "string"),
        ...response.results.flatMap((row) => Object.keys(row)),
      ]),
    ];
    return {
      columns,
      rows: response.results.map((row) =>
        columns.map((column) => valueTextFromConstant(row[column])),
      ),
      resultCount: response.results.length,
      executionTimeMs: elapsed,
      plan: explanation.queryPlan.steps.map((step) => `${step.label}: ${step.query}`),
    };
  });

export const loadDashboard: Effect.Effect<
  DashboardData,
  unknown,
  Triples | ConfigStore.ConfigStore
> = Effect.gen(function* () {
  const triples = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;
  const generatedAt = Date.now();
  const [facts, journal, position, store, live] = yield* Effect.all([
    triples.match({}),
    triples.transactions({ after: 0, limit: 1_000 }),
    triples.currentPosition(),
    config.load(),
    config.resolveRef("live"),
  ]);
  const release = live ?? [...store.snapshots].sort((left, right) => right.seq - left.seq)[0];
  const entities = entitiesFrom(facts);
  const entityTypes = [...new Set(entities.map((entity) => entity.type))].sort().map((name) => {
    const instances = entities.filter((entity) => entity.type === name);
    return {
      name,
      entityCount: instances.length,
      attributeCount: new Set(
        instances.flatMap((entity) => entity.facts.map((fact) => fact.attribute)),
      ).size,
    };
  });
  const applicationFacts = facts.filter(isApplicationFact);
  const transactions = [...journal.transactions].reverse().map(transactionView);
  const definitions = yield* configuredDerivations(store, release);
  const materializations = yield* Effect.forEach(
    definitions,
    (definition) =>
      Derivation.Materialization.current(triples, definition, {
        basis: { validAt: generatedAt },
      }),
    { concurrency: "unbounded" },
  );
  const candidates = materializations.flatMap((state) =>
    state.candidates.map((candidate) => ({
      id: candidate.id,
      revision: candidate.revision,
      definitionId: candidate.definitionId,
      bindings: Object.entries(candidate.result)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([variable, value]) => ({ variable, value: valueTextFromConstant(value) })),
      sourceCount: candidate.sources.length,
      sourceTransactionCount: new Set(
        candidate.sources.flatMap((source) =>
          source.transactionId === undefined ? [] : [source.transactionId],
        ),
      ).size,
    })),
  );
  const objects = configObjectViews(store, release);
  const forms = configuredForms(store, release);

  return {
    generatedAt,
    position,
    metrics: [
      {
        label: "Entities",
        value: String(entities.length),
        detail: `${new Set(entities.map((entity) => entity.type)).size} entity types`,
        tone: "blue",
      },
      {
        label: "Live facts",
        value: String(applicationFacts.length),
        detail: `${applicationFacts.filter((fact) => fact.value.type === "ref").length} graph relationships`,
        tone: "violet",
      },
      {
        label: "Transactions",
        value: String(transactions.length),
        detail: `journal position ${position}`,
        tone: "green",
      },
      {
        label: "Derived candidates",
        value: String(candidates.length),
        detail: `${definitions.length} configured derivations`,
        tone: candidates.length === 0 ? "green" : "amber",
      },
    ],
    entities,
    entityTypes,
    transactions,
    config: {
      label: release?.label ?? "No configuration release",
      snapshotId: release?.id ?? "—",
      rootContentId: release?.rootCid ?? "—",
      sequence: release?.seq ?? 0,
      objectCount: store.objects.size,
      revisionCount: store.revisions.length,
      releaseCount: store.snapshots.length,
      refs: [...store.refs.entries()].map(([name, snapshotId]) => ({ name, snapshotId })),
      releases: [...store.snapshots]
        .sort((left, right) => right.seq - left.seq || right.id.localeCompare(left.id))
        .map((snapshot) => ({
          snapshotId: snapshot.id,
          sequence: snapshot.seq,
          label: snapshot.label,
          rootContentId: snapshot.rootCid,
          parentSnapshotId: snapshot.parentId,
          revisionCount: snapshot.revisionIds.length,
          refs: [...store.refs.entries()]
            .filter(([, snapshotId]) => snapshotId === snapshot.id)
            .map(([name]) => name)
            .sort(),
        })),
      objects,
    },
    forms,
    candidates,
  };
});
