import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as B from "../../src/config/BoolExpr";
import * as Catalog from "../../src/config/Catalog";
import * as Evaluate from "../../src/config/Evaluate";
import * as World from "../../src/config/World";

const DAY = 86_400_000;
const MARCH_3 = 1772496000000;
const clock: World.Clock = { now: MARCH_3, granularity: "day" };

const SSN = "123-45-6789";
const world = World.make({
  "ee/ssn": SSN,
  "ee/role": "caregiver",
  "ee/start_date": MARCH_3 - 5 * DAY,
});

const expr = B.all([B.rule("eligible"), B.exists("ee", "ssn"), B.before("ee", "start_date")]);

const catalog = Effect.runSync(
  Effect.gen(function* () {
    const node = yield* Catalog.ruleNode("eligible", B.eq("ee", "role", "caregiver"));
    return Catalog.fromNodes([node]);
  }),
);

describe("a decision holds no plaintext", () => {
  it("records that a fact was read, not what it said", () => {
    const decision = Evaluate.evaluate(expr, world, clock, catalog);
    const serialized = JSON.stringify(decision);

    expect(decision.truth).toEqual("true");
    // The record is the thing you most want to hand an auditor and least want
    // to be a second copy of the data.
    expect(serialized).not.toContain(SSN);
    expect(serialized).not.toContain("caregiver");
    expect(serialized).toContain("ee/ssn".split("/")[1]);
  });

  it("lets a holder of the value prove it was the one used", () => {
    const decision = Evaluate.evaluate(expr, world, clock, catalog);
    const ssnObservation = decision.observed.find(
      (o) => o._tag === "Fact" && o.attribute === "ssn",
    )!;

    expect(World.matches(ssnObservation, SSN)).toBe(true);
    expect(World.matches(ssnObservation, "999-99-9999")).toBe(false);
  });

  it("records absence without inventing a digest for it", () => {
    const bare = World.make({ "ee/role": "caregiver" });
    const decision = Evaluate.evaluate(B.exists("ee", "ssn"), bare, clock);
    const observation = decision.observed[0];

    expect(observation._tag === "Fact" && observation.present).toBe(false);
    expect(observation._tag === "Fact" && observation.digest).toBeUndefined();
  });
});

describe("verify: the auditor's check", () => {
  it("accepts a decision it was handed", () => {
    const decision = Evaluate.evaluate(expr, world, clock, catalog);
    expect(Evaluate.verify(decision)).toEqual([]);
  });

  it.effect("survives a round trip through JSON, so it can leave the process", () =>
    Effect.gen(function* () {
      const decision = Evaluate.evaluate(expr, world, clock, catalog);
      const wire = JSON.parse(JSON.stringify(decision));
      const decoded = yield* Schema.decodeUnknownEffect(Evaluate.EvaluationSchema)(wire); // prettier-ignore

      // Verification runs on the DECODED tree, not the one still in memory -
      // otherwise it would be checking an object it already trusted.
      expect(Evaluate.verify(decoded)).toEqual([]);
      expect(decoded.cid).toEqual(decision.cid);
    }),
  );

  it("catches a flipped answer at any depth", () => {
    const decision = Evaluate.evaluate(expr, world, clock, catalog);

    // Someone edits a leaf to claim the employee was eligible.
    const tampered: Evaluate.Evaluation = {
      ...decision,
      children: decision.children.map((child, i) =>
        i === 0 ? { ...child, truth: "false" as const } : child,
      ),
    };

    const problems = Evaluate.verify(tampered);
    expect(problems).toHaveLength(1);
    expect(problems[0].path).toEqual("root.0");
  });

  it("catches a rewritten input even when the answer is left alone", () => {
    const decision = Evaluate.evaluate(expr, world, clock, catalog);

    // Swap the observed SSN digest for another value's, keeping every truth
    // intact. The tree still *reads* correctly; the ids do not.
    const tampered: Evaluate.Evaluation = {
      ...decision,
      observed: decision.observed.map((o) =>
        o._tag === "Fact" && o.attribute === "ssn"
          ? { ...o, digest: World.valueDigest("000-00-0000") }
          : o,
      ),
    };

    expect(Evaluate.verify(tampered)).toHaveLength(1);
  });

  it("catches a re-parented child, which a per-node hash would miss", () => {
    const decision = Evaluate.evaluate(expr, world, clock, catalog);
    const [first, second, third] = decision.children;

    // Every child is individually valid; only their arrangement changed.
    const reordered: Evaluate.Evaluation = {
      ...decision,
      children: [second, first, third],
    };

    const problems = Evaluate.verify(reordered);
    expect(problems.map((p) => p.path)).toEqual(["root"]);
  });
});

describe("replay: the stronger claim", () => {
  it("re-derives the decision from the rule and the inputs", () => {
    const decision = Evaluate.evaluate(expr, world, clock, catalog);
    expect(Evaluate.replay(expr, decision, world, clock, catalog)).toBe(true);
  });

  it("fails when the world no longer produces that answer", () => {
    const decision = Evaluate.evaluate(expr, world, clock, catalog);
    const changed = World.withFact(world, "ee", "role", "office");
    expect(Evaluate.replay(expr, decision, changed, clock, catalog)).toBe(false);
  });

  it("fails when the rule that decided it has been republished", () => {
    const decision = Evaluate.evaluate(expr, world, clock, catalog);
    const republished = Effect.runSync(
      Effect.gen(function* () {
        const node = yield* Catalog.ruleNode("eligible", B.eq("ee", "role", "office"));
        return Catalog.fromNodes([node]);
      }),
    );

    // The decision names the rule version it used, so a later edit cannot be
    // passed off as what was in force at the time.
    expect(Evaluate.replay(expr, decision, world, clock, republished)).toBe(false);
  });
});
