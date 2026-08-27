/**
 * One employee, all the way through.
 *
 * Every other test in this package exercises one module against fixtures shaped
 * to suit it. This one runs the whole stack over an example onboarding domain -
 * attributes, a form, pages, fields, a policy, an automation, and the
 * compliance rules that read them - as a single story:
 *
 *   publish a release  ->  register what we owe this employee
 *   they submit facts  ->  the reactor finds exactly what that affected
 *   compliance flips   ->  the decision is a proof we can hand over
 *   a rule changes     ->  we see who flips BEFORE publishing
 *   after publishing   ->  the old proof no longer replays, and says why
 *
 * The value of writing it as one story rather than five unit tests is that the
 * seams between modules are where the design is actually tested. `Releases`
 * covers config versioning and `Reactor` covers invalidation, but until this
 * existed nothing checked that a decision made against a published snapshot
 * survives a republish, or that impact analysis agrees with what the reactor
 * subsequently does.
 *
 * Writing it found two things, which is what it was for.
 *
 * FOUND: rules baked the employee id into the expression, so two employees
 * could not share a catalog - a thousand people meant a thousand separately
 * versioned copies of the same rule, and "did the I-9 rule change?" had no
 * answer. Fixed by `World.SUBJECT`: a rule reads against "this one" and
 * evaluation substitutes. The rule's id stays subject-free so it is one config
 * object; each decision's id does not, because its observations name the real
 * entity. One rule, many proofs.
 *
 * KNOWN SEAM, still open: rules address facts as `<entity>/ssn` while the
 * attribute they correspond to is declared as `employee.ssn`. Nothing enforces
 * that correspondence - a rule can read a fact no attribute declares, and the
 * commit-time dangling-ref check does not catch it because a rule's refs only
 * cover other rules. Closing it means giving `BoolExpr` reads a typed path into
 * the attribute registry, which is real work this test does not pretend is
 * done.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as ConfigNode from "./ConfigNode";
import * as ConfigStore from "./ConfigStore";
import * as Evaluate from "./Evaluate";
import * as Reactor from "./Reactor";
import * as World from "./World";
import {
  BASELINE,
  releaseWithRules,
  ruleSet,
  type AccountConfig,
} from "./domain/OnboardingConfig";

const DAY = 86_400_000;
const MARCH_3 = 1772496000000;
const EE = "ee_1";

const clockAt = (now: number): World.Clock => ({ now, granularity: "day" });

/** The three questions the product actually asks about an employee. */
const QUESTIONS = {
  required: ruleSet(BASELINE)["i9-required"],
  satisfied: ruleSet(BASELINE)["i9-satisfied"],
  overdue: ruleSet(BASELINE)["i9-overdue"],
} as const;

describe("an employee's I-9, end to end", () => {
  it.effect("runs the whole stack over the real domain", () =>
    Effect.gen(function* () {
      // -- 1. Publish -------------------------------------------------------
      // Forms, attributes and the rules that read them ship in one snapshot,
      // which is what makes a decision made under it reproducible later.
      const v1 = yield* releaseWithRules(
        ConfigStore.empty(),
        "2026.1",
        BASELINE
      );
      let store = yield* ConfigStore.setRef(v1.store, "live", v1.snapshot.id);

      expect(ConfigStore.resolveRef(store, "live")?.label).toEqual("2026.1");
      // The rules are ordinary config: versioned, diffable, in the manifest.
      const ruleRevisions = store.revisions.filter((r) => r.kind === "rule");
      expect(ruleRevisions).toHaveLength(6);

      // -- 2. Register what we owe them -------------------------------------
      // Nothing has been submitted. The employee is a caregiver, so the I-9
      // applies, and it is unsatisfied because we know nothing yet.
      let world = World.make({
        [`${EE}/role`]: "caregiver",
        [`${EE}/start_date`]: MARCH_3 + 3 * DAY,
      });
      let now = MARCH_3;
      const envOf = () => Evaluate.env(world, clockAt(now), v1.catalog, EE);

      let reactor = Reactor.empty;
      for (const [key, expr] of Object.entries(QUESTIONS)) {
        reactor = Reactor.register(reactor, key, expr, envOf());
      }

      expect(Reactor.answer(reactor, "required")?.truth).toEqual("true");
      expect(Reactor.answer(reactor, "satisfied")?.truth).toEqual("false");
      // Not yet overdue: the start date is still ahead.
      expect(Reactor.answer(reactor, "overdue")?.truth).toEqual("false");

      // -- 3. They fill in section 1, one field at a time --------------------
      // Each submission is looked up, not scanned for. An SSN affects the
      // questions that read it and nothing else.
      world = World.withFact(world, EE, "ssn", "123-45-6789");
      let step = Reactor.react(reactor, [Reactor.factKey(EE, "ssn")], envOf());
      reactor = step.reactor;

      expect(step.considered).toEqual(["required", "satisfied"]);
      // Reconsidered, but nothing moved - half of section 1 is not section 1.
      expect(step.flipped).toEqual([]);

      world = World.withFact(world, EE, "work_auth", "passport");
      step = Reactor.react(
        reactor,
        [Reactor.factKey(EE, "work_auth")],
        envOf()
      );
      reactor = step.reactor;
      // Still not satisfied: section 2 is the employer's half.
      expect(step.flipped).toEqual([]);
      expect(Reactor.answer(reactor, "satisfied")?.truth).toEqual("false");

      // -- 4. The start date passes ------------------------------------------
      // A clock tick is an input like any other, and reaches only the question
      // that asked about days.
      now = MARCH_3 + 4 * DAY;
      step = Reactor.react(reactor, [Reactor.clockKey("day")], envOf());
      reactor = step.reactor;

      expect(step.considered).toEqual(["overdue"]);
      expect(step.flipped).toEqual([
        { key: "overdue", from: "false", to: "true" },
      ]);

      // -- 5. The employer completes section 2 -------------------------------
      world = World.withFact(world, EE, "i9_verified_at", now);
      step = Reactor.react(
        reactor,
        [Reactor.factKey(EE, "i9_verified_at")],
        envOf()
      );
      reactor = step.reactor;

      expect(
        [...step.flipped].sort((a, b) => a.key.localeCompare(b.key))
      ).toEqual([
        // prettier-ignore
        { key: "overdue", from: "true", to: "false" },
        { key: "required", from: "true", to: "false" },
        { key: "satisfied", from: "false", to: "true" },
      ]);

      // -- 6. The decision is a proof ---------------------------------------
      const compliance = Reactor.answer(reactor, "satisfied")!;
      expect(Evaluate.verify(compliance)).toEqual([]);
      // It holds no plaintext: the SSN it read is not in it.
      expect(JSON.stringify(compliance)).not.toContain("123-45-6789");
      // ...but someone holding the value can prove it was the one used.
      const ssnRead = compliance.observed.find(
        (o) => o._tag === "Fact" && o.attribute === "ssn"
      )!;
      expect(World.matches(ssnRead, "123-45-6789")).toBe(true);
      expect(World.matches(ssnRead, "000-00-0000")).toBe(false);

      // And it re-derives from the rule and the world it was made in.
      expect(
        Evaluate.replay(
          QUESTIONS.satisfied,
          compliance,
          world,
          clockAt(now),
          v1.catalog,
          EE
        )
      ).toBe(true);

      // -- 7. Compliance proposes a change ----------------------------------
      // "Require the I-9 of everyone, not just caregivers." What breaks?
      const widened: AccountConfig = { ...BASELINE, i9AppliesTo: "everyone" };
      const v2 = yield* releaseWithRules(store, "2026.2", widened);

      const changes = ConfigStore.changesBetween(
        v2.store,
        v1.snapshot,
        v2.snapshot
      );
      const ruleChanges = changes
        .filter((c) => c.kind === "rule")
        .map((c) => c.key)
        .sort();

      // Only the rule that moved, plus the two that call it. The forms,
      // attributes, policy and automation are untouched revisions.
      expect(ruleChanges).toEqual(["i9-applies", "i9-overdue", "i9-required"]);
      expect(changes.some((c) => c.kind === "form")).toBe(false);

      // -- 8. Impact, before publishing --------------------------------------
      const before = Reactor.affected(reactor, [Reactor.ruleKey("i9-applies")]);
      // Only the questions that resolved that rule are candidates.
      expect(before).toEqual(["overdue", "required"]);

      // -- 9. Publish, and react --------------------------------------------
      store = yield* ConfigStore.setRef(v2.store, "live", v2.snapshot.id);
      const afterPublish = Reactor.react(
        reactor,
        [Reactor.ruleKey("i9-applies")],
        Evaluate.env(world, clockAt(now), v2.catalog, EE)
      );

      // This employee is a caregiver either way, so widening the rule
      // reconsiders their answers and changes none of them. That distinction -
      // invalidated versus changed - is the difference between a useful
      // notification and a thousand pointless ones.
      expect(afterPublish.considered).toEqual(["overdue", "required"]);
      expect(afterPublish.flipped).toEqual([]);

      // -- 10. Pinning is precise, not blunt ---------------------------------
      // `satisfied` never resolved the rule that changed, so it still replays
      // under 2026.2 - a republish does not invalidate decisions wholesale.
      expect(
        Evaluate.replay(QUESTIONS.satisfied, compliance, world, clockAt(now), v2.catalog, EE) // prettier-ignore
      ).toBe(true);

      // `required` did resolve it. Its decision names a revision that 2026.2
      // no longer contains, so it correctly refuses to re-derive: a later edit
      // cannot be passed off as what was in force at the time.
      const requirement = Reactor.answer(reactor, "required")!;
      expect(
        Evaluate.replay(QUESTIONS.required, requirement, world, clockAt(now), v2.catalog, EE) // prettier-ignore
      ).toBe(false);
      expect(
        Evaluate.replay(QUESTIONS.required, requirement, world, clockAt(now), v1.catalog, EE) // prettier-ignore
      ).toBe(true);
      // Both remain internally valid: nobody tampered with either.
      expect(Evaluate.verify(compliance)).toEqual([]);
      expect(Evaluate.verify(requirement)).toEqual([]);
    })
  );

  it.effect("keeps two employees' decisions independent", () =>
    Effect.gen(function* () {
      // The property that makes the reverse index worth having: one person's
      // submission must not recompute anybody else's compliance.
      const v1 = yield* releaseWithRules(
        ConfigStore.empty(),
        "2026.1",
        BASELINE
      );

      const world = World.make({
        "ee_1/role": "caregiver",
        "ee_2/role": "caregiver",
      });
      // ONE rule, two subjects. This is what subject substitution buys: the
      // catalog holds a single `i9-satisfied`, and each registration binds it
      // to a different employee.
      const satisfied = ruleSet(BASELINE)["i9-satisfied"];
      const envFor = (w: World.World, subject: string) =>
        Evaluate.env(w, clockAt(MARCH_3), v1.catalog, subject);

      let reactor = Reactor.empty;
      reactor = Reactor.register(reactor, "ee_1", satisfied, envFor(world, "ee_1")); // prettier-ignore
      reactor = Reactor.register(reactor, "ee_2", satisfied, envFor(world, "ee_2")); // prettier-ignore

      const filled = World.withFact(world, "ee_1", "ssn", "123-45-6789");
      const reaction = Reactor.react(
        reactor,
        [Reactor.factKey("ee_1", "ssn")],
        envFor(filled, "ee_1")
      );

      expect(reaction.considered).toEqual(["ee_1"]);
      // Untouched object, not a recomputed equal one.
      expect(Reactor.answer(reaction.reactor, "ee_2")).toBe(
        Reactor.answer(reactor, "ee_2")
      );
    })
  );

  it.effect("ships the config and the rules that read it as one unit", () =>
    Effect.gen(function* () {
      // A snapshot that contained the form but not the rule, or vice versa,
      // would let a decision reference configuration nobody deployed.
      const v1 = yield* releaseWithRules(
        ConfigStore.empty(),
        "2026.1",
        BASELINE
      );

      const kinds = new Set(
        [...ConfigNode.walk(v1.snapshot.root)].map(({ node }) => node.kind)
      );

      for (const kind of [
        "attribute",
        "form",
        "form.page",
        "form.field",
        "policy",
        "automation",
        "rule",
      ]) {
        expect(kinds.has(kind), `snapshot is missing ${kind}`).toBe(true);
      }

      // And the whole thing is one id: two accounts on this release are in
      // sync if and only if this matches.
      expect(v1.snapshot.rootCid).toMatch(/^sha256-[0-9a-f]{64}$/);
    })
  );
});
