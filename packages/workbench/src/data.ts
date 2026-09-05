import {
  EntityId,
  KvTriples,
  Triples,
  boolean,
  ref,
  string,
  type DatalogQuery,
  type Triple,
  type TripleInput,
} from "@bjacobso/triplex";
import { ConfigNode, ConfigStore, TypeExpr } from "@bjacobso/triplex/config";
import * as Derivation from "@bjacobso/triplex/derivation";
import { Effect, Layer, Option } from "effect";

export const WorkbenchLayer = ConfigStore.layer.pipe(
  Layer.provideMerge(KvTriples.layerWithScope("workbench")),
);
export const eligibilityQuery: DatalogQuery = {
  find: ["?worker", "?state"],
  where: [
    ["?worker", ":worker/status", "Active"],
    ["?worker", ":worker/i9", "Complete"],
    ["?worker", ":worker/blocked", false],
    ["?worker", ":worker/state", "?state"],
  ],
};

const people = [
  ["Alice Chen", "Product designer", "acme", "CA", "Complete", "Active", false],
  ["Bob Martinez", "Operations specialist", "acme", "NY", "Missing", "Active", false],
  ["Maria Garcia", "Software engineer", "globex", "TX", "Complete", "Active", false],
  ["James Wilson", "Account executive", "acme", "CA", "Complete", "Active", false],
  ["Priya Sharma", "Data analyst", "vertex", "NY", "In review", "Active", false],
  ["Noah Williams", "Customer success", "globex", "WA", "Complete", "Active", false],
  ["Olivia Brown", "Marketing manager", "vertex", "CA", "Complete", "Active", false],
  ["Ethan Davis", "Finance associate", "acme", "TX", "Missing", "Active", false],
  ["Sofia Rodriguez", "People partner", "globex", "NY", "Complete", "Active", false],
  ["Liam Anderson", "Product manager", "vertex", "WA", "Complete", "On leave", false],
  ["Ava Thompson", "Software engineer", "acme", "CA", "Complete", "Active", false],
  ["Oliver Kim", "Security engineer", "globex", "TX", "Complete", "Active", true],
] as const;
export const organizations = [
  { id: "org:acme", name: "Acme Corporation", sector: "Technology", color: "purple" },
  { id: "org:globex", name: "Globex Industries", sector: "Manufacturing", color: "blue" },
  { id: "org:vertex", name: "Vertex Labs", sector: "Research & development", color: "orange" },
];
const fact = (
  id: string,
  type: string,
  attribute: string,
  value: TripleInput["value"],
): TripleInput => ({ entityId: EntityId.make(id), entityType: type, attribute, value });
export const initialize = Effect.gen(function* () {
  const triples = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;
  if (yield* config.resolveRef("live")) return;
  const rule = yield* ConfigNode.makeTyped({
    kind: "derivation",
    key: "worker.eligible",
    type: TypeExpr.any,
    attrs: { label: "Worker eligibility", query: eligibilityQuery, version: 1 },
  });
  const release = yield* config.commit({ label: "workforce-v1", objects: [rule], ref: "live" });
  const facts: TripleInput[] = organizations.flatMap((org) => [
    fact(org.id, "Organization", ":org/name", string(org.name)),
    fact(org.id, "Organization", ":org/sector", string(org.sector)),
  ]);
  people.forEach(([name, role, employer, state, i9, status, blocked], index) => {
    const id = `worker:${index + 1}`;
    facts.push(
      ...Object.entries({ name, role, state, i9, status }).map(([key, value]) =>
        fact(id, "Worker", `:worker/${key}`, string(value)),
      ),
      fact(id, "Worker", ":worker/employer", ref(EntityId.make(`org:${employer}`))),
      fact(id, "Worker", ":worker/blocked", boolean(blocked)),
    );
    const titles =
      i9 === "Missing"
        ? ["Collect I-9 documentation", "Verify employment authorization"]
        : i9 === "In review"
          ? ["Review I-9 documentation"]
          : blocked
            ? ["Resolve blocking violation"]
            : index === 2
              ? ["Complete welcome orientation"]
              : [];
    titles.forEach((title, taskIndex) => {
      const task = `task:${index + 1}:${taskIndex}`;
      facts.push(
        fact(task, "Task", ":task/title", string(title)),
        fact(task, "Task", ":task/worker", ref(EntityId.make(id))),
        fact(task, "Task", ":task/status", string("Open")),
      );
    });
  });
  yield* triples.transact(
    facts.map((input) => ({ op: "assert" as const, ...input })),
    {
      actor: "workbench/demo",
      commandId: "workbench/seed/v1",
      configSnapshot: release.snapshot.id,
    },
  );
});

export const textValue = (fact: Triple | undefined): string =>
  fact ? String(fact.value.value) : "";
export interface Worker {
  id: string;
  name: string;
  role: string;
  employer: string;
  state: string;
  i9: string;
  status: string;
  blocked: boolean;
  eligible: boolean;
  tasks: number;
  facts: readonly Triple[];
}
export const readWorkbench = Effect.gen(function* () {
  const triples = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;
  const release = yield* config.resolveRef("live");
  if (!release) return yield* Effect.fail(new Error("The workforce configuration is missing."));
  const basis = { validAt: Date.now(), recordedAt: Date.now() };
  const definition = yield* Derivation.make({
    name: "worker.eligible",
    query: eligibilityQuery,
    identity: ["?worker"],
    configSnapshot: release.id,
  });
  const [facts, evaluation, journal] = yield* Effect.all([
    triples.match({}, basis),
    Derivation.evaluate(triples, definition, { basis }),
    triples.transactions({ after: 0, limit: 1000 }),
  ]);
  const get = (rows: readonly Triple[], attr: string) =>
    textValue(rows.find((row) => row.attribute === attr));
  const tasks = [
    ...new Set(
      facts.filter((row) => Option.getOrNull(row.entityType) === "Task").map((row) => row.entityId),
    ),
  ].map((id) => {
    const rows = facts.filter((row) => row.entityId === id);
    return {
      id,
      title: get(rows, ":task/title"),
      worker: get(rows, ":task/worker"),
      status: get(rows, ":task/status"),
    };
  });
  const workers: Worker[] = [
    ...new Set(
      facts
        .filter((row) => Option.getOrNull(row.entityType) === "Worker")
        .map((row) => row.entityId),
    ),
  ]
    .map((id) => {
      const rows = facts.filter((row) => row.entityId === id);
      return {
        id,
        name: get(rows, ":worker/name"),
        role: get(rows, ":worker/role"),
        employer: get(rows, ":worker/employer"),
        state: get(rows, ":worker/state"),
        i9: get(rows, ":worker/i9"),
        status: get(rows, ":worker/status"),
        blocked: get(rows, ":worker/blocked") === "true",
        eligible: evaluation.candidates.some((candidate) => candidate.identity["?worker"] === id),
        tasks: tasks.filter((task) => task.worker === id && task.status === "Open").length,
        facts: rows,
      };
    })
    .sort((a, b) => Number(a.id.split(":")[1]) - Number(b.id.split(":")[1]));
  return {
    workers,
    tasks,
    evaluation,
    definition,
    journal: [...journal.transactions].reverse(),
    basis,
    release: release.id,
  };
});
export type WorkbenchData = Effect.Success<typeof readWorkbench>;
export type EditableField = "state" | "i9" | "status";
export const fieldOptions: Record<EditableField, readonly string[]> = {
  state: ["CA", "NY", "TX", "WA"],
  i9: ["Complete", "In review", "Missing"],
  status: ["Active", "On leave"],
};
export const previewChange = (
  data: WorkbenchData,
  worker: Worker,
  field: EditableField,
  value: string,
) =>
  Effect.gen(function* () {
    if (!fieldOptions[field].includes(value))
      return yield* Effect.fail(new Error("Choose a supported value."));
    const previous = worker.facts.find((row) => row.attribute === `:worker/${field}`);
    if (!previous)
      return yield* Effect.fail(new Error("The source fact is missing. Refresh and try again."));
    const assertion = fact(worker.id, "Worker", `:worker/${field}`, string(value));
    const triples = yield* Triples;
    const evaluation = yield* Derivation.Overlay.evaluateOverlay(triples, data.definition, {
      basis: data.basis,
      overlay: { retractions: [previous.id], assertions: [assertion] },
    });
    return {
      worker,
      field,
      value,
      previous,
      assertion,
      eligible: evaluation.candidates.some(
        (candidate) => candidate.identity["?worker"] === worker.id,
      ),
      configSnapshot: data.release,
    };
  });
export type ChangePreview = Effect.Success<ReturnType<typeof previewChange>>;
export const applyChange = (preview: ChangePreview) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    return yield* triples.transact(
      [
        { op: "retract", id: preview.previous.id },
        { op: "assert", ...preview.assertion },
      ],
      {
        actor: "workbench/local-user",
        commandId: `workbench/edit/${crypto.randomUUID()}`,
        configSnapshot: preview.configSnapshot,
        preconditions: [{ _tag: "TripleLive", id: preview.previous.id }],
      },
    );
  });
export const createWorker = (name: string, role: string, employer: string, state: string) =>
  Effect.gen(function* () {
    if (
      !name.trim() ||
      !role.trim() ||
      !organizations.some((org) => org.id === employer) ||
      !fieldOptions.state.includes(state)
    )
      return yield* Effect.fail(
        new Error("Enter a name, role, organization, and supported state."),
      );
    const triples = yield* Triples;
    const id = `worker:${crypto.randomUUID()}`;
    const inputs = [
      ...Object.entries({
        name: name.trim(),
        role: role.trim(),
        state,
        i9: "Missing",
        status: "Active",
      }).map(([key, value]) => fact(id, "Worker", `:worker/${key}`, string(value))),
      fact(id, "Worker", ":worker/employer", ref(EntityId.make(employer))),
      fact(id, "Worker", ":worker/blocked", boolean(false)),
    ];
    yield* triples.transact(
      inputs.map((input) => ({ op: "assert" as const, ...input })),
      { actor: "workbench/local-user", commandId: `workbench/create/${id}` },
    );
    return id;
  });
