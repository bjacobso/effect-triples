import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { Triples } from "../../src/store/Triples.js";
import { ref } from "../../src/Value.js";
import * as Derivation from "../../src/derivation/Derivation.js";

const placementFacts = (placement: string, validTo?: number) =>
  [
    {
      entityId: placement,
      entityType: "Placement",
      attribute: ":placement/worker",
      value: ref("worker:maria"),
      validFrom: 100,
      ...(validTo === undefined ? {} : { validTo }),
    },
    {
      entityId: placement,
      entityType: "Placement",
      attribute: ":placement/employer",
      value: ref("employer:acme"),
      validFrom: 100,
      ...(validTo === undefined ? {} : { validTo }),
    },
  ] as const;

const requirementQuery = {
  find: ["?worker", "?scope"],
  where: [
    ["?placement", ":placement/worker", "?worker"],
    ["?placement", ":placement/employer", "?scope"],
  ],
} as const;

const taskQuery = {
  ...requirementQuery,
  where: [...requirementQuery.where, ["not", ["?worker", ":submission/i9", "?scope"]]],
} as const;

describe("content-addressed derivations", () => {
  it.effect(
    "deduplicates compliance candidates, explains them, and reconciles temporal changes",
    () =>
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* triples.assertBatch([
          ...placementFacts("placement:one", 180),
          ...placementFacts("placement:two"),
        ]);

        const requirement = yield* Derivation.make({
          name: "require.i9",
          query: requirementQuery,
          identity: ["?worker", "?scope"],
          configSnapshot: "config:staffing-v1",
        });
        const task = yield* Derivation.make({
          name: "task.i9",
          query: taskQuery,
          identity: ["?worker", "?scope"],
          configSnapshot: "config:staffing-v1",
        });
        expect(task.dependencies.attributes).toEqual([
          ":placement/employer",
          ":placement/worker",
          ":submission/i9",
        ]);

        const first = yield* Derivation.evaluate(triples, requirement, {
          basis: { validAt: 150 },
        });
        expect(first.candidates).toHaveLength(1);
        expect(first.candidates[0]).toEqual(
          expect.objectContaining({
            identity: { "?scope": "employer:acme", "?worker": "worker:maria" },
            result: { "?scope": "employer:acme", "?worker": "worker:maria" },
          }),
        );
        expect(first.candidates[0]!.sources).toHaveLength(4);
        expect(first.candidates[0]!.nextTemporalBoundary).toBe(180);
        expect(first.candidates[0]!.sources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              transactionId: expect.any(String),
              transactionPosition: expect.any(Number),
            }),
          ]),
        );

        const openBeforeSubmission = yield* Derivation.evaluate(triples, task, {
          basis: { validAt: 110 },
        });
        expect(openBeforeSubmission.candidates).toHaveLength(1);

        yield* triples.assert({
          entityId: "worker:maria",
          entityType: "Worker",
          attribute: ":submission/i9",
          value: ref("employer:acme"),
          validFrom: 120,
          validTo: 200,
        });

        const satisfied = yield* Derivation.evaluate(triples, task, {
          basis: { validAt: 150 },
        });
        expect(satisfied.candidates).toEqual([]);
        expect(Derivation.reconcile(openBeforeSubmission.candidates, satisfied.candidates)).toEqual(
          expect.objectContaining({
            added: [],
            removed: openBeforeSubmission.candidates,
            changed: [],
          }),
        );

        const reopened = yield* Derivation.evaluate(triples, task, {
          basis: { validAt: 200 },
        });
        expect(reopened.candidates).toHaveLength(1);

        const afterSupportingFactsExpire = yield* Derivation.evaluate(triples, requirement, {
          basis: { validAt: 180 },
        });
        expect(afterSupportingFactsExpire.candidates[0]!.id).toBe(first.candidates[0]!.id);
        expect(afterSupportingFactsExpire.candidates[0]!.sources).toHaveLength(2);

        yield* triples.assertBatch(placementFacts("placement:three"));
        const withAnotherSource = yield* Derivation.evaluate(triples, requirement, {
          basis: { validAt: 150 },
        });
        expect(withAnotherSource.candidates[0]!.id).toBe(first.candidates[0]!.id);
        expect(withAnotherSource.candidates[0]!.revision).not.toBe(first.candidates[0]!.revision);
        expect(withAnotherSource.candidates[0]!.sources).toHaveLength(6);
        expect(
          Derivation.reconcile(first.candidates, withAnotherSource.candidates).changed,
        ).toHaveLength(1);
      }).pipe(Effect.provide(KvTriples.layer)),
  );
});
