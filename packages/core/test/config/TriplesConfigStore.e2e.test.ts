import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { Triples } from "../../src/store/Triples.js";
import { string } from "../../src/Value.js";
import * as BoolExpr from "../../src/config/BoolExpr.js";
import * as Catalog from "../../src/config/Catalog.js";
import * as ConfigNode from "../../src/config/ConfigNode.js";
import * as ConfigRuntime from "../../src/config/ConfigRuntime.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as Evaluate from "../../src/config/Evaluate.js";
import * as TypeExpr from "../../src/config/TypeExpr.js";
import * as World from "../../src/config/World.js";

const TriplexLayer = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));

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
  it.effect("runs temporal facts and deployed configuration as one decision system", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStore.ConfigStore;
      const triples = yield* Triples;
      const clearance = yield* attribute(true);
      const policyV1 = yield* policy("Clearance is required");
      const ruleV1 = yield* Catalog.ruleNode(
        "may-deploy",
        BoolExpr.eq(World.SUBJECT, ":employee/clearance", "approved"),
      );

      const clearanceFact = yield* triples.assert({
        entityId: "employee:alice",
        entityType: "Employee",
        attribute: ":employee/clearance",
        value: string("approved"),
      });

      const first = yield* store.commit({
        label: "2026.1",
        objects: [clearance, policyV1, ruleV1],
        ref: "live",
      });
      expect(
        yield* triples.match({ entityType: ConfigStore.System.entityType.snapshot }),
      ).toHaveLength(1);
      expect(yield* triples.match({ entityType: "Employee" })).toHaveLength(1);

      const liveV1 = yield* ConfigRuntime.evaluate({
        ref: "live",
        rule: "may-deploy",
        subject: "employee:alice",
        clock: { now: 1_800_000_000_000, granularity: "day" },
      });
      expect(liveV1.snapshotId).toBe(first.snapshot.id);
      expect(liveV1.evaluation.truth).toBe("true");
      expect(liveV1.evaluation.observed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ _tag: "Config", key: "may-deploy", cid: ruleV1.cid }),
          expect.objectContaining({
            _tag: "Fact",
            entity: "employee:alice",
            attribute: ":employee/clearance",
            present: true,
          }),
        ]),
      );

      const policyV2 = yield* policy("Verified clearance is required");
      const ruleV2 = yield* Catalog.ruleNode(
        "may-deploy",
        BoolExpr.eq(World.SUBJECT, ":employee/clearance", "denied"),
      );
      const second = yield* store.commit({
        label: "2026.2",
        objects: [clearance, policyV2, ruleV2],
        ref: "test",
      });

      expect(second.created.some((revision) => revision.kind === "attribute")).toBe(false);
      expect(
        second.snapshot.revisionIds.find((id) => first.snapshot.revisionIds.includes(id)),
      ).toBeDefined();

      const liveBeforePromotion = yield* ConfigRuntime.evaluate({
        ref: "live",
        rule: "may-deploy",
        subject: "employee:alice",
        clock: { now: 1_800_000_000_000, granularity: "day" },
      });
      const testBeforePromotion = yield* ConfigRuntime.evaluate({
        ref: "test",
        rule: "may-deploy",
        subject: "employee:alice",
        clock: { now: 1_800_000_000_000, granularity: "day" },
      });
      expect(liveBeforePromotion.evaluation.truth).toBe("true");
      expect(testBeforePromotion.evaluation.truth).toBe("false");

      yield* store.setRef("live", second.snapshot.id);
      expect((yield* store.resolveRef("live"))?.rootCid).toBe(second.snapshot.rootCid);
      expect((yield* store.resolveRef("test"))?.rootCid).toBe(second.snapshot.rootCid);

      const promoted = yield* ConfigRuntime.evaluate({
        ref: "live",
        rule: "may-deploy",
        subject: "employee:alice",
        clock: { now: 1_800_000_000_000, granularity: "day" },
      });
      expect(promoted.evaluation.truth).toBe("false");

      yield* triples.transact(
        [
          { op: "retract", id: clearanceFact.id },
          {
            op: "assert",
            entityId: "employee:alice",
            entityType: "Employee",
            attribute: ":employee/clearance",
            value: string("denied"),
          },
        ],
        { user: "security-sync" },
      );

      const afterFactChange = yield* ConfigRuntime.evaluate({
        ref: "live",
        rule: "may-deploy",
        subject: "employee:alice",
        clock: { now: 1_800_000_000_000, granularity: "day" },
      });
      expect(afterFactChange.evaluation.truth).toBe("true");
      expect(afterFactChange.evaluation.cid).not.toBe(promoted.evaluation.cid);

      const impacted = yield* store.impactCandidates({
        kind: "attribute",
        key: "employee/clearance",
      });
      expect(impacted.some((revision) => revision.kind === "policy")).toBe(true);

      expect(Evaluate.verify(afterFactChange.evaluation)).toEqual([]);
      expect(ConfigRuntime.verify(afterFactChange)).toEqual([]);

      const tampered = { ...afterFactChange.evaluation, truth: "false" as const };
      expect(Evaluate.verify(tampered)).toHaveLength(1);
      expect(
        ConfigRuntime.verify({ ...afterFactChange, snapshotRootCid: first.snapshot.rootCid }),
      ).toEqual([expect.objectContaining({ path: "decision" })]);

      yield* triples.assert({
        entityId: "employee:alice",
        entityType: "Employee",
        attribute: ":employee/clearance",
        value: string("approved"),
      });
      const ambiguous = yield* ConfigRuntime.evaluate({
        ref: "live",
        rule: "may-deploy",
        subject: "employee:alice",
        clock: { now: 1_800_000_000_000, granularity: "day" },
      }).pipe(Effect.flip);
      expect(ambiguous).toBeInstanceOf(ConfigRuntime.AmbiguousDecisionFactError);
    }).pipe(Effect.provide(TriplexLayer)),
  );
});
