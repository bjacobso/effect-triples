import { describe, expect, it } from "@effect/vitest";

import * as B from "./BoolExpr";
import * as Evaluate from "./Evaluate";
import * as World from "./World";

const DAY = 86_400_000;
const MARCH_3 = 1772496000000; // a Monday, UTC midnight
const at = (now: number, granularity: World.Granularity = "day"): World.Clock => ({ now, granularity }); // prettier-ignore

const base = World.make({
  "ee_1/role": "caregiver",
  "ee_1/start_date": MARCH_3 - 5 * DAY,
  "ee_1/i9_complete": false,
  "ee_2/role": "office",
});

const truth = (expr: B.BoolExpr, world = base, clock = at(MARCH_3)) =>
  Evaluate.evaluate(expr, world, clock).truth;

describe("three-valued evaluation", () => {
  it("distinguishes absent from false", () => {
    // The whole reason for a third value. If a missing fact evaluated to
    // `false`, `not(eq(...))` would report compliance for an employee we know
    // nothing about.
    expect(truth(B.eq("ee_1", "role", "caregiver"))).toEqual("true");
    expect(truth(B.eq("ee_1", "role", "office"))).toEqual("false");
    expect(truth(B.eq("ee_9", "role", "caregiver"))).toEqual("unknown");
    expect(truth(B.not(B.eq("ee_9", "role", "caregiver")))).toEqual("unknown");

    // `exists` is the one place absence is a definite answer, because that is
    // the question being asked.
    expect(truth(B.exists("ee_9", "role"))).toEqual("false");
  });

  it("follows the Kleene tables", () => {
    const T = B.lit(true);
    const F = B.lit(false);
    const U = B.eq("nobody", "nothing", 1);

    expect(truth(B.not(U))).toEqual("unknown");
    expect(truth(B.all([T, U]))).toEqual("unknown");
    expect(truth(B.all([F, U]))).toEqual("false");
    expect(truth(B.any([T, U]))).toEqual("true");
    expect(truth(B.any([F, U]))).toEqual("unknown");
  });
});

describe("evaluation is content-addressed", () => {
  const expr = B.all([
    B.eq("ee_1", "role", "caregiver"),
    B.before("ee_1", "start_date"),
  ]);

  it("is a function of its inputs, not of when it ran", () => {
    const a = Evaluate.evaluate(expr, base, at(MARCH_3));
    const b = Evaluate.evaluate(expr, World.make({ ...Object.fromEntries(base.facts) }), at(MARCH_3 + 1000)); // prettier-ignore

    // Rebuilt world, clock moved by a second, day granularity: same identity.
    expect(b.cid).toEqual(a.cid);
    expect(b.truth).toEqual("true");
  });

  it("gives provenance as a merkle tree, not a log", () => {
    const evaluation = Evaluate.evaluate(expr, base, at(MARCH_3));
    const nodes = [...Evaluate.walk(evaluation)];

    expect(nodes).toHaveLength(3);
    // A child's id participates in its parent's, so an explanation cannot be
    // edited without changing the root.
    const mutated = Evaluate.evaluate(
      B.all([B.eq("ee_1", "role", "office"), B.before("ee_1", "start_date")]),
      base,
      at(MARCH_3)
    );
    expect(mutated.children[1].cid).toEqual(evaluation.children[1].cid);
    expect(mutated.cid).not.toEqual(evaluation.cid);
  });

  it("discovers its dependency set rather than being told one", () => {
    // `Any` is where the static and dynamic answers diverge, and why the cache
    // cannot key on `mentions`.
    const branching = B.any([
      B.eq("ee_1", "role", "caregiver"),
      B.eq("ee_2", "role", "office"),
    ]);
    const evaluation = Evaluate.evaluate(branching, base, at(MARCH_3));

    expect(B.mentions(branching)).toHaveLength(2);
    expect(
      evaluation.observed.map((o) =>
        o._tag === "Fact" ? `${o.entity}/${o.attribute}` : "clock"
      )
    ).toEqual(["ee_1/role", "ee_2/role"]);
  });
});

describe("the cache", () => {
  const expr = B.all([
    B.eq("ee_1", "role", "caregiver"),
    B.exists("ee_1", "work_auth"),
  ]);

  it("hits when nothing it read has moved", () => {
    let cache = Evaluate.emptyCache();
    const first = Evaluate.cached(cache, expr, base, at(MARCH_3));
    cache = first.cache;
    const second = Evaluate.cached(cache, expr, base, at(MARCH_3));

    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(second.evaluation.cid).toEqual(first.evaluation.cid);
  });

  it("hits when an unrelated fact changes - the whole point", () => {
    // If the key were the whole world, one submitted value would invalidate
    // every cached answer in the account.
    let cache = Evaluate.cached(Evaluate.emptyCache(), expr, base, at(MARCH_3)).cache; // prettier-ignore

    const unrelated = World.withFact(base, "ee_2", "role", "warehouse");
    const result = Evaluate.cached(cache, expr, unrelated, at(MARCH_3));

    expect(result.hit).toBe(true);
  });

  it("misses when a fact it read changes", () => {
    let cache = Evaluate.cached(Evaluate.emptyCache(), expr, base, at(MARCH_3)).cache; // prettier-ignore

    const changed = World.withFact(base, "ee_1", "role", "office");
    const result = Evaluate.cached(cache, expr, changed, at(MARCH_3));

    expect(result.hit).toBe(false);
    expect(result.evaluation.truth).toEqual("false");
  });

  it("misses when a fact it found ABSENT appears", () => {
    // The subtle one. `work_auth` was missing, so the answer depended on its
    // absence. Without recording that, filling it in leaves a stale answer
    // saying the requirement is still unmet.
    const first = Evaluate.cached(Evaluate.emptyCache(), expr, base, at(MARCH_3)); // prettier-ignore
    expect(first.evaluation.truth).toEqual("false");

    const filled = World.withFact(base, "ee_1", "work_auth", "i9");
    const second = Evaluate.cached(first.cache, expr, filled, at(MARCH_3));

    expect(second.hit).toBe(false);
    expect(second.evaluation.truth).toEqual("true");
  });

  it("keeps one entry per distinct input set, and reuses both", () => {
    const filled = World.withFact(base, "ee_1", "work_auth", "i9");
    let cache = Evaluate.emptyCache();
    cache = Evaluate.cached(cache, expr, base, at(MARCH_3)).cache;
    cache = Evaluate.cached(cache, expr, filled, at(MARCH_3)).cache;

    // Going back to a world seen before is a hit, not a re-evaluation: the key
    // is the content of the inputs, not the order they arrived in.
    const back = Evaluate.cached(cache, expr, base, at(MARCH_3));
    expect(back.hit).toBe(true);
    expect(back.evaluation.truth).toEqual("false");
  });
});

describe("the clock, which is where this could have been wrong", () => {
  const dueCheck = B.before("ee_1", "start_date", "day");

  it("caches for a day when the question is about days", () => {
    let cache = Evaluate.cached(Evaluate.emptyCache(), dueCheck, base, at(MARCH_3)).cache; // prettier-ignore

    // Same day, 6 hours later: still a hit. An evaluator reaching for
    // Date.now() could not honestly claim this.
    const later = Evaluate.cached(cache, dueCheck, base, at(MARCH_3 + 6 * 3600_000)); // prettier-ignore
    expect(later.hit).toBe(true);
  });

  it("invalidates when the day turns", () => {
    let cache = Evaluate.cached(Evaluate.emptyCache(), dueCheck, base, at(MARCH_3)).cache; // prettier-ignore
    const tomorrow = Evaluate.cached(cache, dueCheck, base, at(MARCH_3 + DAY));
    expect(tomorrow.hit).toBe(false);
  });

  it("records the granularity it observed, not the instant", () => {
    const evaluation = Evaluate.evaluate(dueCheck, base, at(MARCH_3 + 12345));
    const tick = evaluation.observed.find((o) => o._tag === "Clock");

    expect(tick).toBeDefined();
    expect(tick?._tag === "Clock" && tick.granularity).toEqual("day");
    expect(tick?._tag === "Clock" && tick.bucket).toEqual(
      Math.floor(MARCH_3 / DAY)
    );
  });

  it("does not let an instant-grained question poison a day-grained one", () => {
    // Two expressions over the same fact at different granularities are
    // different expressions and cache independently.
    const instantCheck = B.before("ee_1", "start_date", "instant");
    let cache = Evaluate.emptyCache();
    cache = Evaluate.cached(
      cache,
      dueCheck,
      base,
      at(MARCH_3, "instant")
    ).cache;
    const other = Evaluate.cached(cache, instantCheck, base, at(MARCH_3, "instant")); // prettier-ignore

    expect(other.hit).toBe(false);
    expect(B.id(dueCheck)).not.toEqual(B.id(instantCheck));

    // ...and the instant-grained one really is invalidated by a millisecond.
    const tick = Evaluate.cached(other.cache, instantCheck, base, at(MARCH_3 + 1)); // prettier-ignore
    expect(tick.hit).toBe(false);
  });
});

describe("the cache scales with dependency shapes, not with population", () => {
  it("keeps one shape for one expression across many subjects", () => {
    // The flat-list cache this replaced was quadratic: re-observing every
    // stored entry on each lookup cost 0.3s at 200 subjects and 17s at 1600.
    // Grouping by dependency shape makes a lookup one re-observation and one
    // map read, because WHICH inputs an expression reads is far more stable
    // than what they contain.
    const expr = B.all([B.eq("ee", "id", 0), B.exists("ee", "work_auth")]);

    let cache = Evaluate.emptyCache();
    for (let i = 0; i < 500; i++) {
      cache = Evaluate.cached(cache, expr, World.make({ "ee/id": i }), at(MARCH_3)).cache; // prettier-ignore
    }

    expect(cache.misses).toEqual(500);
    expect(Evaluate.shapeCount(cache, expr)).toEqual(1);
  });

  it("bounds shapes by the expression's branches, not by the data", () => {
    // `Before` observes a clock; `Exists` does not. The two arms therefore
    // produce different dependency shapes - but only two, however many
    // subjects run through them.
    const expr = B.any([
      B.exists("ee", "waiver"),
      B.before("ee", "start_date"),
    ]);
    let cache = Evaluate.emptyCache();

    for (let i = 0; i < 200; i++) {
      const world =
        i % 2 === 0
          ? World.make({ "ee/waiver": "yes" })
          : World.make({ "ee/start_date": MARCH_3 - i * DAY });
      cache = Evaluate.cached(cache, expr, world, at(MARCH_3)).cache;
    }

    expect(Evaluate.shapeCount(cache, expr)).toBeLessThanOrEqual(2);
  });

  it("still invalidates correctly under the grouped layout", () => {
    // Regrouping must not weaken the guarantee: a fact that was read and moved
    // is still a miss, an unread fact that moved is still a hit.
    const expr = B.eq("ee", "role", "caregiver");
    const seeded = World.withFact(base, "ee", "role", "caregiver");
    const first = Evaluate.cached(Evaluate.emptyCache(), expr, seeded, at(MARCH_3)); // prettier-ignore
    expect(first.evaluation.truth).toEqual("true");

    const unread = World.withFact(seeded, "ee_1", "nickname", "Sam");
    expect(Evaluate.cached(first.cache, expr, unread, at(MARCH_3)).hit).toBe(true); // prettier-ignore

    const changed = World.withFact(seeded, "ee", "role", "office");
    expect(Evaluate.cached(first.cache, expr, changed, at(MARCH_3)).hit).toBe(false); // prettier-ignore
  });
});
