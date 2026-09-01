import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import * as BoolExpr from "../../src/config/BoolExpr.js";
import * as Catalog from "../../src/config/Catalog.js";
import * as ConfigNode from "../../src/config/ConfigNode.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as Evaluate from "../../src/config/Evaluate.js";
import * as TypeExpr from "../../src/config/TypeExpr.js";
import * as World from "../../src/config/World.js";

const ConfigLayer = ConfigStore.layer.pipe(Layer.provide(KvTriples.layer));

const AttributeType = TypeExpr.struct({
  label: TypeExpr.required(TypeExpr.text),
  required: TypeExpr.required(TypeExpr.boolean),
});

const attribute = (required: boolean) =>
  ConfigNode.makeTyped({
    kind: "attribute",
    key: "employee/clearance",
    type: AttributeType,
    attrs: { label: "Security clearance", required },
  });

const policy = (message: string) =>
  ConfigNode.make({
    kind: "policy",
    key: "may-deploy",
    attrs: { message },
    refs: [
      {
        rel: "reads",
        kind: "attribute",
        key: "employee/clearance",
      },
    ],
  });

describe("Triples-backed typed configuration", () => {
  it.effect("persists releases, promotes refs, queries impact, and verifies decisions", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStore.ConfigStore;
      const clearance = yield* attribute(true);
      const policyV1 = yield* policy("Clearance is required");

      const first = yield* store.commit({
        label: "2026.1",
        objects: [clearance, policyV1],
        ref: "live",
      });

      const policyV2 = yield* policy("Verified clearance is required");
      const second = yield* store.commit({
        label: "2026.2",
        objects: [clearance, policyV2],
        ref: "test",
      });

      expect(second.created.some((revision) => revision.kind === "attribute")).toBe(false);
      expect(
        second.snapshot.revisionIds.find((id) => first.snapshot.revisionIds.includes(id)),
      ).toBeDefined();

      yield* store.setRef("live", second.snapshot.id);
      expect((yield* store.resolveRef("live"))?.rootCid).toBe(second.snapshot.rootCid);
      expect((yield* store.resolveRef("test"))?.rootCid).toBe(second.snapshot.rootCid);

      const impacted = yield* store.impactCandidates({
        kind: "attribute",
        key: "employee/clearance",
      });
      expect(impacted.some((revision) => revision.kind === "policy")).toBe(true);

      const expr = BoolExpr.eq(World.SUBJECT, "clearance", "approved");
      const rule = yield* Catalog.ruleNode("may-deploy", expr);
      const catalog = Catalog.fromNodes([rule]);
      const decision = Evaluate.evaluate(
        BoolExpr.rule("may-deploy"),
        World.make({ "employee:alice/clearance": "approved" }),
        { now: 1_800_000_000_000, granularity: "day" },
        catalog,
        "employee:alice",
      );

      expect(decision.truth).toBe("true");
      expect(Evaluate.verify(decision)).toEqual([]);

      const tampered = { ...decision, truth: "false" as const };
      expect(Evaluate.verify(tampered)).toHaveLength(1);
    }).pipe(Effect.provide(ConfigLayer)),
  );
});
