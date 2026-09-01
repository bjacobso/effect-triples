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

import { Schema } from "effect";

import * as BoolExpr from "./BoolExpr";
import * as Catalog from "./Catalog";
import * as CanonicalJson from "./CanonicalJson";
import * as ContentId from "./ContentId";
import * as World from "./World";

export type Truth = "true" | "false" | "unknown";

/**
 * Everything an evaluation may consult: facts, the clock, and configuration.
 *
 * Bundled rather than passed separately because the whole point of the join is
 * that these are three sources of the same kind of thing - an input that is
 * observed, addressed, and can invalidate an answer.
 */
export interface Env {
  readonly world: World.World;
  readonly clock: World.Clock;
  readonly catalog: Catalog.Catalog;
  /** Who `World.SUBJECT` refers to, when a rule is about "this one". */
  readonly subject?: string;
}

export const env = (
  world: World.World,
  clock: World.Clock,
  catalog: Catalog.Catalog = Catalog.empty,
  subject?: string
): Env => ({ world, clock, catalog, subject });

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

/**
 * Read a fact for comparison and record it for provenance.
 *
 * Deliberately two values. The evaluator needs the actual value to decide the
 * predicate; the record needs only a digest. Splitting them here is what keeps
 * plaintext out of everything downstream.
 */
const readFact = (
  world: World.World,
  entity: string,
  attribute: string
): {
  readonly value: World.Value | undefined;
  readonly observed: World.Observed;
} => ({
  // prettier-ignore
  value: World.read(world, entity, attribute),
  observed: World.observe(world, entity, attribute),
});

/**
 * Which entity a read names. Unresolved `$subject` is a missing input, not a
 * crash - the same three-valued treatment an absent fact gets.
 */
const resolve = (entity: string, env: Env): string | undefined =>
  entity === World.SUBJECT ? env.subject : entity;

const go = (
  expr: BoolExpr.BoolExpr,
  env: Env,
  calling: ReadonlySet<string>
): Evaluation => {
  const { world, clock } = env;
  if (
    (expr._tag === "Exists" || expr._tag === "Eq" || expr._tag === "Before") &&
    resolve(expr.entity, env) === undefined
  ) {
    return node({
      truth: "unknown",
      expr,
      observed: [],
      reason: "evaluated without a subject",
    });
  }
  switch (expr._tag) {
    case "Lit":
      return node({
        truth: expr.value ? "true" : "false",
        expr,
        observed: [],
      });

    case "Exists": {
      const fact = readFact(world, resolve(expr.entity, env)!, expr.attribute);
      return node({
        truth: fact.value === undefined ? "false" : "true",
        expr,
        observed: [fact.observed],
      });
    }

    case "Eq": {
      const fact = readFact(world, resolve(expr.entity, env)!, expr.attribute);
      if (fact.value === undefined) {
        // Absent, not unequal. Reporting `false` would let `not(eq(...))`
        // report compliance for an employee we know nothing about.
        return node({
          truth: "unknown",
          expr,
          observed: [fact.observed],
          reason: `${resolve(expr.entity, env)}/${expr.attribute} is absent`,
        });
      }
      return node({
        truth: fact.value === expr.value ? "true" : "false",
        expr,
        observed: [fact.observed],
      });
    }

    case "Before": {
      const fact = readFact(world, resolve(expr.entity, env)!, expr.attribute);
      const tick: World.Observed = {
        _tag: "Clock",
        granularity: expr.granularity,
        bucket: World.bucket({ now: clock.now, granularity: expr.granularity }),
      };
      if (fact.value === undefined) {
        return node({
          truth: "unknown",
          expr,
          observed: [fact.observed, tick],
          reason: `${resolve(expr.entity, env)}/${expr.attribute} is absent`,
        });
      }
      if (typeof fact.value !== "number") {
        return node({
          truth: "unknown",
          expr,
          observed: [fact.observed, tick],
          reason: `${resolve(expr.entity, env)}/${expr.attribute} is not an instant`,
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
        observed: [fact.observed, tick],
      });
    }

    case "Rule": {
      const found = Catalog.lookup(env.catalog, expr.key);
      if (!found) {
        // Absent from the catalog, exactly like an absent fact: recorded with a
        // null cid so publishing the rule later invalidates this answer.
        return node({
          truth: "unknown",
          expr,
          observed: [{ _tag: "Config", kind: Catalog.RULE_KIND, key: expr.key, cid: null }], // prettier-ignore
          reason: `rule ${expr.key} is not in this configuration`,
        });
      }
      const observed: World.Observed = {
        _tag: "Config",
        kind: Catalog.RULE_KIND,
        key: expr.key,
        cid: found.cid,
      };
      if (calling.has(expr.key)) {
        // A rule that reaches itself has no fixed point here, and looping
        // would hang rather than fail. `unknown` is the honest answer.
        return node({
          truth: "unknown",
          expr,
          observed: [observed],
          reason: `rule ${expr.key} is recursive`,
        });
      }
      const child = go(found.expr, env, new Set(calling).add(expr.key));
      return node({
        truth: child.truth,
        expr,
        observed: [observed],
        children: [child],
      });
    }

    case "Not": {
      const child = go(expr.expr, env, calling);
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
      const children = expr.exprs.map((e) => go(e, env, calling));
      return node({
        truth: allOf(children.map((c) => c.truth)),
        expr,
        observed: [],
        children,
      });
    }

    case "Any": {
      const children = expr.exprs.map((e) => go(e, env, calling));
      return node({
        truth: anyOf(children.map((c) => c.truth)),
        expr,
        observed: [],
        children,
      });
    }
  }
};

export const evaluate = (
  expr: BoolExpr.BoolExpr,
  world: World.World,
  clock: World.Clock,
  catalog: Catalog.Catalog = Catalog.empty,
  subject?: string
): Evaluation => go(expr, env(world, clock, catalog, subject), new Set());

/**
 * Replay a recorded dependency set against the current inputs.
 *
 * Lives here rather than in `World` because a dependency may now be a config
 * node, and re-observing one means asking the catalog - the same question,
 * asked of a different source.
 */
export const reobserve = (
  observed: ReadonlyArray<World.Observed>,
  env: Env
): ReadonlyArray<World.Observed> =>
  observed.map((o) => {
    if (o._tag === "Clock") {
      return { _tag: "Clock", granularity: o.granularity, bucket: World.bucket({ now: env.clock.now, granularity: o.granularity }) }; // prettier-ignore
    }
    if (o._tag === "Config") {
      const found = Catalog.lookup(env.catalog, o.key);
      return { _tag: "Config", kind: o.kind, key: o.key, cid: found?.cid ?? null }; // prettier-ignore
    }
    return World.observe(env.world, o.entity, o.attribute);
  });

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
  clock: World.Clock,
  catalog: Catalog.Catalog = Catalog.empty,
  subject?: string
): {
  readonly evaluation: Evaluation;
  readonly cache: Cache;
  readonly hit: boolean;
} => {
  const scope = env(world, clock, catalog, subject);
  const exprId = BoolExpr.id(expr);
  const shapes = cache.entries.get(exprId) ?? [];

  for (const shape of shapes) {
    const now = reobserve(shape.probe, scope);
    const found = shape.byClosure.get(World.closureId(now));
    if (found) {
      return {
        evaluation: found,
        cache: { ...cache, hits: cache.hits + 1 },
        hit: true,
      };
    }
  }

  const evaluation = go(expr, scope, new Set());
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

// --- deploy impact ----------------------------------------------------------

export interface Impact {
  readonly considered: number;
  /** Provably unaffected: none of the config they read moved. Never evaluated. */
  readonly skipped: number;
  readonly reevaluated: number;
  readonly flipped: ReadonlyArray<{
    readonly subject: number;
    readonly from: Truth;
    readonly to: Truth;
  }>;
}

/**
 * "If I publish this, what changes?" - answered before publishing.
 *
 * This is what the join is for. The closure an evaluation recorded is not only
 * a cache key, it is an invalidation index: a subject whose answer read none of
 * the rules that moved *cannot* flip, so it is skipped without being evaluated.
 * Work is proportional to the blast radius of the change rather than to the
 * size of the population, which is what makes the preview affordable to run on
 * every publish rather than as an offline report.
 *
 * Note the asymmetry with facts. Config deps are resolvable up front - the two
 * catalogs are both in hand - so the skip decision is made without touching a
 * world. Fact deps could not be pruned this way, because knowing which facts an
 * answer would read requires evaluating it.
 */
export const impact = (
  cache: Cache,
  expr: BoolExpr.BoolExpr,
  subjects: ReadonlyArray<World.World>,
  clock: World.Clock,
  before: Catalog.Catalog,
  after: Catalog.Catalog
): { readonly impact: Impact; readonly cache: Cache } => {
  const flipped: Array<{ subject: number; from: Truth; to: Truth }> = [];
  let working = cache;
  let skipped = 0;
  let reevaluated = 0;

  subjects.forEach((world, subject) => {
    const previous = cached(working, expr, world, clock, before);
    working = previous.cache;

    const configDeps = previous.evaluation.observed.filter(
      (o) => o._tag === "Config"
    );
    const moved = reobserve(configDeps, env(world, clock, after)).some(
      (now, i) => now._tag === "Config" && now.cid !== (configDeps[i] as { cid: ContentId.ContentId | null }).cid // prettier-ignore
    );

    if (!moved) {
      skipped++;
      return;
    }

    const next = cached(working, expr, world, clock, after);
    working = next.cache;
    reevaluated++;

    if (next.evaluation.truth !== previous.evaluation.truth) {
      flipped.push({
        subject,
        from: previous.evaluation.truth,
        to: next.evaluation.truth,
      });
    }
  });

  return {
    impact: { considered: subjects.length, skipped, reevaluated, flipped },
    cache: working,
  };
};

// --- proof ------------------------------------------------------------------

/**
 * A decision, in the form it leaves the process in.
 *
 * Plain data with no values in it - the observations carry digests - so a tree
 * can be handed to an auditor, stored, or sent over a wire without becoming a
 * second copy of the facts it was made from.
 */
export const EvaluationSchema: Schema.Codec<Evaluation> = Schema.suspend(
  (): Schema.Codec<Evaluation> =>
    Schema.Struct({
      truth: Schema.Literals(["true", "false", "unknown"]),
      cid: ContentId.ContentIdSchema,
      expr: ContentId.ContentIdSchema,
      observed: Schema.Array(
        Schema.Union([
          Schema.Struct({
            _tag: Schema.Literal("Config"),
            kind: Schema.String,
            key: Schema.String,
            cid: Schema.NullOr(ContentId.ContentIdSchema),
          }),
          Schema.Struct({
            _tag: Schema.Literal("Fact"),
            entity: Schema.String,
            attribute: Schema.String,
            present: Schema.Boolean,
            digest: Schema.optional(ContentId.ContentIdSchema),
          }),
          Schema.Struct({
            _tag: Schema.Literal("Clock"),
            granularity: Schema.Literals(["instant", "day"]),
            bucket: Schema.Number,
          })
        ])
      ),
      children: Schema.Array(EvaluationSchema),
      reason: Schema.optional(Schema.String),
    }) as unknown as Schema.Codec<Evaluation>
);

export interface Tampered {
  readonly path: string;
  readonly claimed: ContentId.ContentId;
  readonly actual: ContentId.ContentId;
}

/**
 * Recompute every id in a decision from its own contents.
 *
 * This is the auditor's check, and it needs nothing but the tree: no database,
 * no catalog, no trust in whoever handed it over. Each node's id is derived
 * from its answer, the expression that produced it, the digest of everything it
 * observed, and its children's ids - so altering any of those, at any depth,
 * breaks the root. A decision that verifies is a decision nobody edited after
 * the fact.
 *
 * What it deliberately does not check is whether the answer *follows* from the
 * inputs; that is `replay`, and it needs the rule.
 */
export const verify = (
  evaluation: Evaluation,
  path = "root"
): ReadonlyArray<Tampered> => {
  const found = evaluation.children.flatMap((child, i) =>
    verify(child, `${path}.${i}`)
  );

  const actual = ContentId.hash(
    "config-graph/evaluation",
    CanonicalJson.encodeOrThrow({
      v: 1,
      expr: evaluation.expr,
      truth: evaluation.truth,
      closure: World.closureId(evaluation.observed),
      children: evaluation.children.map((c) => c.cid),
    })
  );

  return actual === evaluation.cid
    ? found
    : [...found, { path, claimed: evaluation.cid, actual }];
};

/**
 * Re-derive a decision from the rule and the inputs it recorded.
 *
 * The stronger claim: not merely that the record is internally consistent, but
 * that evaluating this expression against a world matching the recorded
 * observations reproduces exactly this answer. Because the record holds digests
 * rather than values, the caller supplies the world - which is the point. An
 * auditor with the data can reproduce the decision; an auditor without it can
 * still verify the decision was not tampered with.
 */
export const replay = (
  expr: BoolExpr.BoolExpr,
  evaluation: Evaluation,
  world: World.World,
  clock: World.Clock,
  catalog: Catalog.Catalog = Catalog.empty,
  subject?: string
): boolean =>
  go(expr, env(world, clock, catalog, subject), new Set()).cid ===
  evaluation.cid;
