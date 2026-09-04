import { EntityId, Triples, string } from "@bjacobso/triplex";
import { Effect, Exit } from "effect";
import { expect as expectScene, given, role, scene, text } from "foldkit/scene";
import { describe, expect, it } from "vitest";

import {
  initialQueryText,
  loadDashboard,
  loadEntityHistory,
  loadEntityTypePage,
  saveEntity,
  updateConfigObject,
} from "./data.js";
import { DashboardDemoLayer } from "./demo/layer.js";
import { LoadDashboard, Message, RunQuery, init, initialModel, update, view } from "./main.js";

describe("Triplex dashboard", () => {
  it("loads real Triplex facts, config, journal records, and derivations through a Foldkit command", async () => {
    const loaded = await Effect.runPromise(
      LoadDashboard().effect.pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(loaded._tag).toBe("SucceededLoadDashboard");
    if (loaded._tag !== "SucceededLoadDashboard") return;
    expect(loaded.data.entities.length).toBeGreaterThanOrEqual(7);
    expect(loaded.data.transactions.length).toBeGreaterThanOrEqual(4);
    expect(loaded.data.config.refs).toContainEqual({
      name: "live",
      snapshotId: loaded.data.config.snapshotId,
    });
    expect(loaded.data.config.refs.map((ref) => ref.name).sort()).toEqual(["live", "test"]);
    expect(loaded.data.config.releases).toHaveLength(2);
    const quizFormObject = loaded.data.config.objects.find(
      (object) => object.kind === "form" && object.key === "quiz/bitemporal-facts",
    );
    expect(quizFormObject?.history).toHaveLength(2);
    expect(quizFormObject?.history[0]?.parentRevisionId).toBe(
      quizFormObject?.history[1]?.revisionId,
    );
    expect(quizFormObject?.history.map((revision) => revision.releases)).toEqual([
      ["learning-2026.fall"],
      ["learning-2026.fall-beta"],
    ]);
    expect(quizFormObject?.history[0]?.body).toContain("triplex.form/v1");
    expect(loaded.data.forms).toContainEqual(
      expect.objectContaining({
        key: "quiz/bitemporal-facts",
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "validTimeDefinition", input: "textarea" }),
          expect.objectContaining({ name: "correctionAxis", input: "select" }),
        ]),
      }),
    );
    expect(loaded.data.candidates).toHaveLength(1);
    expect(loaded.data.candidates[0]?.bindings).toContainEqual({
      variable: "?studentName",
      value: "Mina Patel",
    });

    scene(
      { update, view },
      given({ ...initialModel, page: "overview", busy: false, data: loaded.data }),
      expectScene(role("heading", { name: "See the database think" })).toExist(),
      expectScene(role("button", { name: "Refresh data" })).toBeEnabled(),
      expectScene(text("?studentName = Mina Patel")).toExist(),
    );

    scene(
      { update, view },
      given({
        ...initialModel,
        page: "forms",
        busy: false,
        data: loaded.data,
        selectedFormKey: "quiz/bitemporal-facts",
      }),
      expectScene(role("heading", { name: "Bitemporal Facts Check-in" })).toExist(),
      expectScene(text("What does valid time describe?")).toExist(),
      expectScene(role("button", { name: "Validate answers" })).toBeEnabled(),
    );

    scene(
      { update, view },
      given({
        ...initialModel,
        page: "config",
        busy: false,
        data: loaded.data,
        selectedConfigObject: "form\u0000quiz/bitemporal-facts",
      }),
      expectScene(role("heading", { name: "Revision history" })).toExist(),
      expectScene(text("learning-2026.fall-beta")).toExist(),
      expectScene(role("button", { name: "Edit & publish" })).toBeEnabled(),
    );
  });

  it("executes the Datalog workbench through the same app resource layer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* LoadDashboard().effect;
        return yield* RunQuery({ source: initialQueryText }).effect;
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result._tag).toBe("SucceededRunQuery");
    if (result._tag !== "SucceededRunQuery") return;
    expect(result.result.columns).toEqual(["?entity", "?attribute", "?value"]);
    expect(result.result.rows.length).toBeGreaterThan(20);
  });

  it("cursor-pages one reflected entity type against a stable temporal snapshot", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* loadEntityTypePage("Student", null, 1);
        const triples = yield* Triples;
        yield* Effect.sleep(2);
        yield* triples.assert({
          entityId: EntityId.make("student:late-arrival"),
          entityType: "Student",
          attribute: ":person/name",
          value: string("Late Arrival"),
        });
        const second = yield* loadEntityTypePage("Student", first.nextCursor, 1);
        const wrongType = yield* Effect.exit(loadEntityTypePage("Teacher", first.nextCursor, 1));
        return { first, second, wrongType };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result.first.totalCount).toBe(6);
    expect(result.first.nextCursor).not.toBeNull();
    expect(result.second.totalCount).toBe(6);
    expect([
      ...result.first.entities.map((entity) => entity.id),
      ...result.second.entities.map((entity) => entity.id),
    ]).not.toContain("student:late-arrival");
    expect(Exit.isFailure(result.wrongType)).toBe(true);
  });

  it("keeps navigation and async work explicit in update", () => {
    const started = init();
    expect(started.commands?.[0]?.name).toBe("LoadDashboard");

    const next = update(started.model, Message.SelectedPage({ page: "query" }));
    expect(next.model.page).toBe("query");

    const running = update(next.model, Message.RequestedQuery());
    expect(running.model.busy).toBe(true);
    expect(running.commands?.[0]?.name).toBe("RunQuery");
  });

  it("creates and edits entities through attributed transactions with entity-scoped history", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* saveEntity({
          mode: "create",
          entityId: "student:dashboard-editor",
          entityType: "Student",
          facts: JSON.stringify([
            { attribute: ":person/name", value: { type: "string", value: "Dashboard Editor" } },
            { attribute: ":student/status", value: { type: "string", value: "active" } },
          ]),
        });
        const updated = yield* saveEntity({
          mode: "edit",
          entityId: "student:dashboard-editor",
          entityType: "Student",
          facts: JSON.stringify([
            { attribute: ":person/name", value: { type: "string", value: "Dashboard Editor" } },
            { attribute: ":student/status", value: { type: "string", value: "graduated" } },
          ]),
        });
        const history = yield* loadEntityHistory("student:dashboard-editor");
        const triples = yield* Triples;
        const current = yield* triples.entity(EntityId.make("student:dashboard-editor"));
        return { created, updated, history, current };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result.created).toContain("Created student:dashboard-editor");
    expect(result.updated).toContain("Updated student:dashboard-editor");
    expect(result.history).toHaveLength(2);
    expect(result.history[0]?.changes.some((change) => change.op === "retract")).toBe(true);
    expect(result.history[0]?.changes.some((change) => change.value === "graduated")).toBe(true);
    expect(
      result.current.some(
        (fact) => fact.value.type === "string" && fact.value.value === "graduated",
      ),
    ).toBe(true);
  });

  it("publishes edited config as a new immutable revision and moves live", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* loadDashboard;
        const form = before.config.objects.find(
          (object) => object.kind === "form" && object.key === "quiz/bitemporal-facts",
        )!;
        const body = JSON.parse(form.history[0]!.body) as { attrs: Record<string, unknown> };
        const notice = yield* updateConfigObject({
          identity: "form\u0000quiz/bitemporal-facts",
          attrs: JSON.stringify({ ...body.attrs, title: "Bitemporal Facts Lab" }),
          label: "learning-2026.fall-dashboard-edit",
        });
        const after = yield* loadDashboard;
        return { before, after, notice };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result.notice).toContain("moved live");
    expect(result.after.config.releaseCount).toBe(result.before.config.releaseCount + 1);
    expect(result.after.config.label).toBe("learning-2026.fall-dashboard-edit");
    const updated = result.after.config.objects.find(
      (object) => object.kind === "form" && object.key === "quiz/bitemporal-facts",
    );
    expect(updated?.history).toHaveLength(3);
    expect(updated?.history[0]?.body).toContain("Bitemporal Facts Lab");
    expect(result.after.forms[0]?.title).toBe("Bitemporal Facts Lab");
  });
});
