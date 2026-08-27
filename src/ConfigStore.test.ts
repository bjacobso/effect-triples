/**
 * The store author's view: does the versioning machinery hold its invariants?
 *
 * These are deliberately not product questions. They are about whether a
 * revision is reused when nothing moved, whether a snapshot that references
 * something absent is refused, whether two processes agree on an id, and which
 * of the three tiers `recheck` uses to clear a candidate schema. A form never
 * appears in the reasoning - it happens to be the fixture, because a realistic
 * graph exercises cycles and shared subtrees that a toy one would not.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as ConfigStore from "./ConfigStore";
import {
  BASELINE,
  buildAccount,
  FieldKind,
  FieldAttrs,
  FieldAttrsV2,
  release,
  type AccountConfig,
} from "./domain/OnboardingConfig";

describe("ConfigStore invariants", () => {
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
