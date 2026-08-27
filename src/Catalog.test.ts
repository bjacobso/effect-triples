import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as B from "./BoolExpr";
import * as Catalog from "./Catalog";
import * as ConfigNode from "./ConfigNode";
import * as Evaluate from "./Evaluate";
import * as World from "./World";

const DAY = 86_400_000;
const MARCH_3 = 1772496000000;
const clock: World.Clock = { now: MARCH_3, granularity: "day" };

const facts = World.make({
  "ee/role": "caregiver",
  "ee/start_date": MARCH_3 - 5 * DAY,
});

/** Build a catalog from (key, expr) pairs, as a published snapshot would. */
const catalogOf = (rules: Readonly<Record<string, B.BoolExpr>>) =>
  Effect.gen(function* () {
    const nodes = yield* Effect.all(
      Object.entries(rules).map(([key, expr]) => Catalog.ruleNode(key, expr))
    );
    return { catalog: Catalog.fromNodes(nodes), nodes };
  });

describe("a rule is a config node", () => {
  it.effect("derives its refs from the expression, not from the author", () =>
    Effect.gen(function* () {
      // A rule cannot claim a dependency set different from the one it will
      // actually resolve, because the refs come out of the structure.
      const node = yield* Catalog.ruleNode(
        "eligible",
        B.all([B.rule("is-caregiver"), B.exists("ee", "work_auth")])
      );

      expect(node.refs).toEqual([
        { rel: "calls", kind: "rule", key: "is-caregiver" },
      ]);
    })
  );

  it.effect("gets dependency-aware identity from the existing machinery", () =>
    Effect.gen(function* () {
      // `closureId` already answers "would this behave differently" for config.
      // A rule calling a changed sub-rule is the same question as a form
      // reading a retyped attribute - and it is the same code answering it.
      const caller = yield* Catalog.ruleNode("outer", B.rule("inner"));
      const innerV1 = yield* Catalog.ruleNode("inner", B.lit(true));
      const innerV2 = yield* Catalog.ruleNode("inner", B.lit(false));

      const withV1 = yield* ConfigNode.closureId(caller, [
        { kind: "rule", key: "inner", cid: innerV1.cid },
      ]);
      const withV2 = yield* ConfigNode.closureId(caller, [
        { kind: "rule", key: "inner", cid: innerV2.cid },
      ]);

      expect(caller.cid).toBeDefined();
      expect(withV1).not.toEqual(withV2);
    })
  );
});

describe("config and facts invalidate through one mechanism", () => {
  const expr = B.rule("eligible");

  it.effect(
    "observes a resolved rule by content id, like a fact by value",
    () =>
      Effect.gen(function* () {
        const { catalog } = yield* catalogOf({
          eligible: B.eq("ee", "role", "caregiver"),
        });
        const evaluation = Evaluate.evaluate(expr, facts, clock, catalog);

        expect(evaluation.truth).toEqual("true");
        expect(
          evaluation.observed.map((o) =>
            o._tag === "Config"
              ? `config:${o.key}`
              : o._tag === "Fact"
                ? `fact:${o.entity}/${o.attribute}`
                : "clock"
          )
        ).toEqual(["config:eligible", "fact:ee/role"]);
      })
  );

  it.effect("misses when the rule it resolved is republished", () =>
    Effect.gen(function* () {
      const v1 = yield* catalogOf({
        eligible: B.eq("ee", "role", "caregiver"),
      });
      const v2 = yield* catalogOf({ eligible: B.eq("ee", "role", "office") });

      const first = Evaluate.cached(Evaluate.emptyCache(), expr, facts, clock, v1.catalog); // prettier-ignore
      expect(first.evaluation.truth).toEqual("true");

      const second = Evaluate.cached(first.cache, expr, facts, clock, v2.catalog); // prettier-ignore
      expect(second.hit).toBe(false);
      expect(second.evaluation.truth).toEqual("false");
    })
  );

  it.effect("HITS when an unrelated rule is republished", () =>
    Effect.gen(function* () {
      // The trap the fact side had. If publishing anything invalidated
      // everything, the config closure would be too coarse to be useful.
      const v1 = yield* catalogOf({
        eligible: B.eq("ee", "role", "caregiver"),
        unrelated: B.lit(true),
      });
      const v2 = yield* catalogOf({
        eligible: B.eq("ee", "role", "caregiver"),
        unrelated: B.lit(false),
      });

      const first = Evaluate.cached(Evaluate.emptyCache(), expr, facts, clock, v1.catalog); // prettier-ignore
      const second = Evaluate.cached(first.cache, expr, facts, clock, v2.catalog); // prettier-ignore

      expect(second.hit).toBe(true);
    })
  );

  it.effect("misses when a fact changes, through the same cache", () =>
    Effect.gen(function* () {
      const { catalog } = yield* catalogOf({
        eligible: B.eq("ee", "role", "caregiver"),
      });
      const first = Evaluate.cached(Evaluate.emptyCache(), expr, facts, clock, catalog); // prettier-ignore

      const moved = World.withFact(facts, "ee", "role", "office");
      const second = Evaluate.cached(first.cache, expr, moved, clock, catalog);

      expect(second.hit).toBe(false);
      // One cache, one closure, two kinds of input.
      expect(Evaluate.shapeCount(second.cache, expr)).toEqual(1);
    })
  );

  it.effect("treats a rule missing from the catalog as an absent input", () =>
    Effect.gen(function* () {
      const empty = Evaluate.cached(Evaluate.emptyCache(), expr, facts, clock, Catalog.empty); // prettier-ignore
      expect(empty.evaluation.truth).toEqual("unknown");

      const { catalog } = yield* catalogOf({
        eligible: B.eq("ee", "role", "caregiver"),
      });
      const published = Evaluate.cached(empty.cache, expr, facts, clock, catalog); // prettier-ignore

      expect(published.hit).toBe(false);
      expect(published.evaluation.truth).toEqual("true");
    })
  );
});

describe("pinning: two versions of a rule cannot be confused", () => {
  const expr = B.rule("eligible");

  it.effect("keeps both answers and serves each to its own version", () =>
    Effect.gen(function* () {
      const v3 = yield* catalogOf({
        eligible: B.eq("ee", "role", "caregiver"),
      });
      const v4 = yield* catalogOf({ eligible: B.eq("ee", "role", "office") });

      let cache = Evaluate.emptyCache();
      const a = Evaluate.cached(cache, expr, facts, clock, v3.catalog);
      cache = a.cache;
      const b = Evaluate.cached(cache, expr, facts, clock, v4.catalog);
      cache = b.cache;

      // In-flight work pinned to v3 still resolves to the v3 answer, from
      // cache, even though head has moved on.
      const pinned = Evaluate.cached(cache, expr, facts, clock, v3.catalog);
      expect(pinned.hit).toBe(true);
      expect(pinned.evaluation.truth).toEqual("true");
      expect(pinned.evaluation.cid).toEqual(a.evaluation.cid);

      expect(b.evaluation.truth).toEqual("false");
      expect(b.evaluation.cid).not.toEqual(a.evaluation.cid);
    })
  );

  it.effect(
    "puts the rule's version inside the evaluation's own identity",
    () =>
      Effect.gen(function* () {
        // Provenance cites the rule revision because the revision is part of the
        // answer's id - not metadata recorded beside it.
        const v3 = yield* catalogOf({ eligible: B.lit(true) });
        const v4 = yield* catalogOf({ eligible: B.all([B.lit(true)]) });

        const a = Evaluate.evaluate(expr, facts, clock, v3.catalog);
        const b = Evaluate.evaluate(expr, facts, clock, v4.catalog);

        expect(a.truth).toEqual(b.truth);
        expect(a.cid).not.toEqual(b.cid);
      })
  );
});

describe("rules that call rules", () => {
  it.effect("composes, and observes every rule on the path", () =>
    Effect.gen(function* () {
      const { catalog } = yield* catalogOf({
        eligible: B.all([B.rule("is-caregiver"), B.rule("started")]),
        "is-caregiver": B.eq("ee", "role", "caregiver"),
        started: B.before("ee", "start_date"),
      });

      const evaluation = Evaluate.evaluate(B.rule("eligible"), facts, clock, catalog); // prettier-ignore
      expect(evaluation.truth).toEqual("true");

      const configDeps = evaluation.observed
        .filter((o) => o._tag === "Config")
        .map((o) => (o._tag === "Config" ? o.key : ""));
      expect(configDeps.sort()).toEqual([
        "eligible",
        "is-caregiver",
        "started",
      ]);
    })
  );

  it.effect("refuses to loop on a recursive rule", () =>
    Effect.gen(function* () {
      // No fixed point is computed here, and looping would hang rather than
      // fail. `unknown` with a reason is the honest answer.
      const { catalog } = yield* catalogOf({
        a: B.rule("b"),
        b: B.rule("a"),
      });

      const evaluation = Evaluate.evaluate(B.rule("a"), facts, clock, catalog);
      expect(evaluation.truth).toEqual("unknown");
      expect(
        [...Evaluate.walk(evaluation)].some((n) =>
          n.reason?.includes("recursive")
        )
      ).toBe(true);
    })
  );

  it.effect("invalidates a caller when a callee two levels down changes", () =>
    Effect.gen(function* () {
      const before = yield* catalogOf({
        top: B.rule("mid"),
        mid: B.rule("leaf"),
        leaf: B.lit(true),
      });
      const after = yield* catalogOf({
        top: B.rule("mid"),
        mid: B.rule("leaf"),
        leaf: B.lit(false),
      });

      const expr = B.rule("top");
      const first = Evaluate.cached(Evaluate.emptyCache(), expr, facts, clock, before.catalog); // prettier-ignore
      const second = Evaluate.cached(first.cache, expr, facts, clock, after.catalog); // prettier-ignore

      expect(first.evaluation.truth).toEqual("true");
      expect(second.hit).toBe(false);
      expect(second.evaluation.truth).toEqual("false");
    })
  );
});

describe("deploy impact preview", () => {
  const expr = B.rule("eligible");
  const subjects = Array.from({ length: 200 }, (_, i) =>
    World.make({ "ee/role": i % 4 === 0 ? "office" : "caregiver" })
  );

  it.effect("says who flips, before publishing", () =>
    Effect.gen(function* () {
      const before = yield* catalogOf({ eligible: B.eq("ee", "role", "caregiver") }); // prettier-ignore
      const after = yield* catalogOf({
        eligible: B.eq("ee", "role", "office"),
      });

      const { impact } = Evaluate.impact(
        Evaluate.emptyCache(),
        expr,
        subjects,
        clock,
        before.catalog,
        after.catalog
      );

      expect(impact.considered).toEqual(200);
      expect(impact.reevaluated).toEqual(200);
      // Every subject flips: the two rules are exact complements here.
      expect(impact.flipped).toHaveLength(200);
      expect(impact.flipped[0]).toMatchObject({ from: "false", to: "true" });
    })
  );

  it.effect("costs the blast radius, not the population", () =>
    Effect.gen(function* () {
      // Publishing a rule nobody's answer read must not re-evaluate anybody.
      // The closure is the invalidation index, so this is decided without
      // touching a single world.
      const before = yield* catalogOf({
        eligible: B.eq("ee", "role", "caregiver"),
        unrelated: B.lit(true),
      });
      const after = yield* catalogOf({
        eligible: B.eq("ee", "role", "caregiver"),
        unrelated: B.lit(false),
      });

      const { impact } = Evaluate.impact(
        Evaluate.emptyCache(),
        expr,
        subjects,
        clock,
        before.catalog,
        after.catalog
      );

      expect(impact.skipped).toEqual(200);
      expect(impact.reevaluated).toEqual(0);
      expect(impact.flipped).toEqual([]);
    })
  );

  it.effect("prunes through a call chain, not just direct references", () =>
    Effect.gen(function* () {
      const mk = (leaf: B.BoolExpr) =>
        catalogOf({ eligible: B.rule("mid"), mid: B.rule("leaf"), leaf, spare: B.lit(true) }); // prettier-ignore

      const before = yield* mk(B.eq("ee", "role", "caregiver"));
      const after = yield* mk(B.eq("ee", "role", "office"));

      const changed = Evaluate.impact(
        Evaluate.emptyCache(),
        expr,
        subjects,
        clock,
        before.catalog,
        after.catalog
      );
      expect(changed.impact.reevaluated).toEqual(200);

      // ...and a sibling rule off the path prunes everything.
      const sibling = yield* catalogOf({
        eligible: B.rule("mid"),
        mid: B.rule("leaf"),
        leaf: B.eq("ee", "role", "caregiver"),
        spare: B.lit(false),
      });
      const untouched = Evaluate.impact(
        Evaluate.emptyCache(),
        expr,
        subjects,
        clock,
        before.catalog,
        sibling.catalog
      );
      expect(untouched.impact.skipped).toEqual(200);
    })
  );
});
