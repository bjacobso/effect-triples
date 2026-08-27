/**
 * Content-addressed evaluation: is `evaluate(expr, facts) -> result` a pure
 * function you can address by identity?
 *
 * If it is, four things that are normally built as separate systems collapse
 * into one structure:
 *
 * - the **cache key** for an evaluation;
 * - the **invalidation index** - a fact moves, its observation moves, and
 *   exactly the evaluations that read it die;
 * - the **provenance tree** an auditor needs, which is itself a merkle DAG; and
 * - **verifiable history** - a root id proves what was decided from what,
 *   without trusting the database that stored it.
 *
 * The catch, and the reason this needs an experiment rather than an assertion,
 * is that the cache key is not knowable *before* evaluating. Which facts an
 * expression reads depends on the facts - `Any` short-circuits, so a run may
 * touch two of five. That is a dynamic-dependency problem, and the resolution
 * is the one build systems reached: record what was observed, and on the next
 * lookup replay *those* observations against the current world and compare
 * digests. A hit means every input the last run actually looked at is
 * unchanged. Facts it never looked at may change freely, which is the whole
 * point - otherwise one submitted value invalidates an account.
 *
 * Two subtleties are what make this correct rather than merely fast. Absence is
 * recorded as an observation, so filling in a missing fact invalidates. And the
 * clock is an explicit input at a declared granularity, so a question about
 * days is cached for a day rather than being either wrong or useless.
 */

import * as BoolExpr from "./BoolExpr";
import * as CanonicalJson from "./CanonicalJson";
import * as ContentId from "./ContentId";
import * as World from "./World";

export type Truth = "true" | "false" | "unknown";

export interface Evaluation {
  readonly truth: Truth;
  /** Identity of this evaluation: the expression, the inputs, and the answer. */
  readonly cid: ContentId.ContentId;
  readonly expr: ContentId.ContentId;
  /** Everything this node and its children looked at, deduped. */
  readonly observed: ReadonlyArray<World.Observed>;
  readonly children: ReadonlyArray<Evaluation>;
  readonly reason?: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const dedupe = (
  observed: ReadonlyArray<World.Observed>
): ReadonlyArray<World.Observed> => {
  const byKey = new Map<string, World.Observed>();
  for (const o of observed) byKey.set(World.observedKey(o), o);
  return [...byKey.entries()].sort(([a], [b]) => cmp(a, b)).map(([, o]) => o);
};

const node = (input: {
  readonly truth: Truth;
  readonly expr: BoolExpr.BoolExpr;
  readonly observed: ReadonlyArray<World.Observed>;
  readonly children?: ReadonlyArray<Evaluation>;
  readonly reason?: string;
}): Evaluation => {
  const children = input.children ?? [];
  const observed = dedupe([
    ...input.observed,
    ...children.flatMap((c) => c.observed),
  ]);
  const expr = BoolExpr.id(input.expr);

  // The node's identity covers the answer, the expression that produced it, and
  // the children by id - so provenance is a merkle DAG, not a log.
  const cid = ContentId.hash(
    "config-graph/evaluation",
    CanonicalJson.encodeOrThrow({
      v: 1,
      expr,
      truth: input.truth,
      closure: World.closureId(observed),
      children: children.map((c) => c.cid),
    })
  );

  return { truth: input.truth, cid, expr, observed, children, reason: input.reason }; // prettier-ignore
};

// Kleene three-valued logic. Collapsing `unknown` to `false` here is how a
// negated predicate silently reports compliance for a missing fact.
const notOf = (t: Truth): Truth =>
  t === "unknown" ? "unknown" : t === "true" ? "false" : "true";

const allOf = (ts: ReadonlyArray<Truth>): Truth =>
  ts.includes("false") ? "false" : ts.includes("unknown") ? "unknown" : "true";

const anyOf = (ts: ReadonlyArray<Truth>): Truth =>
  ts.includes("true") ? "true" : ts.includes("unknown") ? "unknown" : "false";

const readFact = (
  world: World.World,
  entity: string,
  attribute: string
): World.Observed => {
  const value = World.read(world, entity, attribute);
  return value === undefined
    ? { _tag: "Fact", entity, attribute, present: false }
    : { _tag: "Fact", entity, attribute, present: true, value };
};

export const evaluate = (
  expr: BoolExpr.BoolExpr,
  world: World.World,
  clock: World.Clock
): Evaluation => {
  switch (expr._tag) {
    case "Lit":
      return node({
        truth: expr.value ? "true" : "false",
        expr,
        observed: [],
      });

    case "Exists": {
      const fact = readFact(world, expr.entity, expr.attribute);
      return node({
        truth: fact._tag === "Fact" && fact.present ? "true" : "false",
        expr,
        observed: [fact],
      });
    }

    case "Eq": {
      const fact = readFact(world, expr.entity, expr.attribute);
      if (fact._tag !== "Fact" || !fact.present) {
        // Absent, not unequal. Reporting `false` would let `not(eq(...))`
        // report compliance for an employee we know nothing about.
        return node({
          truth: "unknown",
          expr,
          observed: [fact],
          reason: `${expr.entity}/${expr.attribute} is absent`,
        });
      }
      return node({
        truth: fact.value === expr.value ? "true" : "false",
        expr,
        observed: [fact],
      });
    }

    case "Before": {
      const fact = readFact(world, expr.entity, expr.attribute);
      const tick: World.Observed = {
        _tag: "Clock",
        granularity: expr.granularity,
        bucket: World.bucket({ now: clock.now, granularity: expr.granularity }),
      };
      if (fact._tag !== "Fact" || !fact.present) {
        return node({
          truth: "unknown",
          expr,
          observed: [fact, tick],
          reason: `${expr.entity}/${expr.attribute} is absent`,
        });
      }
      if (typeof fact.value !== "number") {
        return node({
          truth: "unknown",
          expr,
          observed: [fact, tick],
          reason: `${expr.entity}/${expr.attribute} is not an instant`,
        });
      }
      // Compare in the declared granularity, so a day-grained question is not
      // answered differently one millisecond later.
      const factBucket = World.bucket({
        now: fact.value,
        granularity: expr.granularity,
      });
      return node({
        truth: factBucket < tick.bucket ? "true" : "false",
        expr,
        observed: [fact, tick],
      });
    }

    case "Not": {
      const child = evaluate(expr.expr, world, clock);
      return node({
        truth: notOf(child.truth),
        expr,
        observed: [],
        children: [child],
      });
    }

    case "All": {
      // Deliberately not short-circuiting: a full provenance tree is worth more
      // than skipping work, and short-circuiting would make the observed set
      // depend on evaluation order.
      const children = expr.exprs.map((e) => evaluate(e, world, clock));
      return node({
        truth: allOf(children.map((c) => c.truth)),
        expr,
        observed: [],
        children,
      });
    }

    case "Any": {
      const children = expr.exprs.map((e) => evaluate(e, world, clock));
      return node({
        truth: anyOf(children.map((c) => c.truth)),
        expr,
        observed: [],
        children,
      });
    }
  }
};

// --- the cache --------------------------------------------------------------

/**
 * Entries sharing one dependency *shape* - the same facts and clocks by key,
 * differing only in their values.
 *
 * Grouping this way is what keeps lookup from degrading. The obvious cache is a
 * flat list per expression, re-observing each entry until one matches; that is
 * O(entries) per lookup and quadratic over a population. Measured on an
 * expression reading a high-cardinality fact it was 0.3s at 200 subjects and
 * 17s at 1600 - each doubling quadrupling, which rules it out for an account.
 *
 * The observation is that *which* inputs an expression reads is far more stable
 * than what they contain. So re-observe once per shape, digest, and look the
 * closure up in a map. Distinct shapes are bounded by the expression's branch
 * structure, not by the number of subjects, so the common case is one
 * re-observation and one map read regardless of population.
 */
interface Shape {
  /** A representative observation set; only its keys are used to re-observe. */
  readonly probe: ReadonlyArray<World.Observed>;
  readonly byClosure: ReadonlyMap<ContentId.ContentId, Evaluation>;
}

export interface Cache {
  readonly entries: ReadonlyMap<ContentId.ContentId, ReadonlyArray<Shape>>;
  readonly hits: number;
  readonly misses: number;
}

export const emptyCache = (): Cache => ({
  entries: new Map(),
  hits: 0,
  misses: 0,
});

/** Identity of a dependency shape: the observed keys, ignoring their values. */
const shapeKey = (observed: ReadonlyArray<World.Observed>): string =>
  observed.map(World.observedKey).sort(cmp).join("|");

/** How many distinct dependency shapes this expression has produced. */
export const shapeCount = (cache: Cache, expr: BoolExpr.BoolExpr): number =>
  (cache.entries.get(BoolExpr.id(expr)) ?? []).length;

/**
 * Evaluate, reusing a previous answer when every input that answer actually
 * looked at is unchanged.
 *
 * A hit costs one re-observation per shape plus a map read - it never traverses
 * the world, the expression, or the other cached answers.
 */
export const cached = (
  cache: Cache,
  expr: BoolExpr.BoolExpr,
  world: World.World,
  clock: World.Clock
): {
  readonly evaluation: Evaluation;
  readonly cache: Cache;
  readonly hit: boolean;
} => {
  // prettier-ignore
  const exprId = BoolExpr.id(expr);
  const shapes = cache.entries.get(exprId) ?? [];

  for (const shape of shapes) {
    const now = World.reobserve(shape.probe, world, clock);
    const found = shape.byClosure.get(World.closureId(now));
    if (found) {
      return {
        evaluation: found,
        cache: { ...cache, hits: cache.hits + 1 },
        hit: true,
      };
    }
  }

  const evaluation = evaluate(expr, world, clock);
  const key = shapeKey(evaluation.observed);
  const closure = World.closureId(evaluation.observed);

  const next = shapes.some((s) => shapeKey(s.probe) === key)
    ? shapes.map((s) =>
        shapeKey(s.probe) === key
          ? {
              probe: s.probe,
              byClosure: new Map(s.byClosure).set(closure, evaluation),
            }
          : s
      )
    : [
        ...shapes,
        {
          probe: evaluation.observed,
          byClosure: new Map([[closure, evaluation]]),
        },
      ];

  const entries = new Map(cache.entries);
  entries.set(exprId, next);

  return {
    evaluation,
    cache: { entries, hits: cache.hits, misses: cache.misses + 1 },
    hit: false,
  };
};

/** Depth-first walk of the provenance tree. */
export function* walk(evaluation: Evaluation): Generator<Evaluation> {
  yield evaluation;
  for (const child of evaluation.children) yield* walk(child);
}
