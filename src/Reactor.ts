/**
 * The reverse index: given something that changed, which decisions are stale?
 *
 * `Evaluate.cached` answers the forward question - here is a subject, is the
 * answer still good - and that is enough for a request handler. It is not
 * enough for a product, which needs the other direction: a value was submitted,
 * a rule was published, midnight passed; *now what needs recomputing?* Without
 * an index the only honest answer is "everything", and a compliance engine that
 * re-derives an entire account on every keystroke is not one you can run.
 *
 * A registration is a standing interest in one question - "is this employee
 * eligible" - and the engine keeps its current answer. Registrations are
 * indexed by what their answers observed, so a change is looked up rather than
 * scanned for. The cost of a change is the number of decisions that actually
 * depended on it.
 *
 * Two things make this work, and both are inherited rather than added.
 *
 * **All three input kinds index identically.** An observation is a fact, a
 * clock bucket, or a config node, and `World.observedKey` names all of them the
 * same way. So a submitted value, a republished rule, and the day turning all
 * flow through one index - the same collapse the forward closure already made.
 *
 * **Absence indexes like presence.** A decision that read "no work
 * authorisation on file" is registered under `fact:ee/work_auth` exactly as if
 * it had found one, so filling the gap finds it. That falls out of keying on
 * the observation rather than on the value, and it is the case a naive index
 * over existing rows would miss entirely.
 *
 * There is no cache here on purpose. `Evaluate.Cache` grows one entry per
 * distinct input set and never forgets; a reactor holds exactly one evaluation
 * per registration, so memory is bounded by what the product is actually
 * watching. The index is the optimisation, and it is a better one.
 */

import * as BoolExpr from "./BoolExpr";
import * as Evaluate from "./Evaluate";
import * as World from "./World";

export interface Registration {
  readonly key: string;
  readonly expr: BoolExpr.BoolExpr;
  readonly evaluation: Evaluate.Evaluation;
}

export interface Reactor {
  readonly registrations: ReadonlyMap<string, Registration>;
  /** Observation key to the registrations whose answers depended on it. */
  readonly index: ReadonlyMap<string, ReadonlySet<string>>;
}

export const empty: Reactor = {
  registrations: new Map(),
  index: new Map(),
};

// --- naming the things that can change --------------------------------------

export const factKey = (entity: string, attribute: string): string =>
  World.observedKey({ _tag: "Fact", entity, attribute, present: false });

export const ruleKey = (key: string): string =>
  World.observedKey({ _tag: "Config", kind: "rule", key, cid: null });

export const clockKey = (granularity: World.Granularity): string =>
  World.observedKey({ _tag: "Clock", granularity, bucket: 0 });

// --- registry ---------------------------------------------------------------

const reindex = (
  index: ReadonlyMap<string, ReadonlySet<string>>,
  key: string,
  observed: ReadonlyArray<World.Observed>,
  previous?: ReadonlyArray<World.Observed>
): ReadonlyMap<string, ReadonlySet<string>> => {
  const next = new Map(index);

  // A refreshed answer may depend on different inputs than it used to - a
  // branch that short-circuited last time may not this time - so the old edges
  // have to go or the index slowly accumulates phantom dependents.
  for (const o of previous ?? []) {
    const slot = World.observedKey(o);
    const holders = new Set(next.get(slot));
    holders.delete(key);
    if (holders.size === 0) next.delete(slot);
    else next.set(slot, holders);
  }

  for (const o of observed) {
    const slot = World.observedKey(o);
    next.set(slot, new Set(next.get(slot)).add(key));
  }

  return next;
};

/** Record a standing interest, evaluating it once. */
export const register = (
  reactor: Reactor,
  key: string,
  expr: BoolExpr.BoolExpr,
  env: Evaluate.Env
): Reactor => {
  const evaluation = Evaluate.evaluate(expr, env.world, env.clock, env.catalog);
  const existing = reactor.registrations.get(key);

  return {
    registrations: new Map(reactor.registrations).set(key, {
      key,
      expr,
      evaluation,
    }),
    index: reindex(
      reactor.index,
      key,
      evaluation.observed,
      existing?.evaluation.observed
    ),
  };
};

export const unregister = (reactor: Reactor, key: string): Reactor => {
  const existing = reactor.registrations.get(key);
  if (!existing) return reactor;

  const registrations = new Map(reactor.registrations);
  registrations.delete(key);
  return {
    registrations,
    index: reindex(reactor.index, key, [], existing.evaluation.observed),
  };
};

export const answer = (
  reactor: Reactor,
  key: string
): Evaluate.Evaluation | undefined =>
  reactor.registrations.get(key)?.evaluation;

// --- reacting ---------------------------------------------------------------

/**
 * Which registrations depended on any of these inputs?
 *
 * A lookup per changed input, not a scan. This is the whole reason the index
 * exists: the work of reacting is proportional to what the change touched, not
 * to how much the product is watching.
 */
export const affected = (
  reactor: Reactor,
  changed: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const keys = new Set<string>();
  for (const slot of changed) {
    for (const key of reactor.index.get(slot) ?? []) keys.add(key);
  }
  return [...keys].sort();
};

export interface Flip {
  readonly key: string;
  readonly from: Evaluate.Truth;
  readonly to: Evaluate.Truth;
}

/**
 * Recompute the given registrations and report which answers actually moved.
 *
 * Recomputation and change are different events: a rule edit may invalidate a
 * thousand decisions and flip none of them. Callers that notify people care
 * about the flips; callers that keep a read model current care about both.
 */
export const refresh = (
  reactor: Reactor,
  keys: ReadonlyArray<string>,
  env: Evaluate.Env
): { readonly reactor: Reactor; readonly flipped: ReadonlyArray<Flip> } => {
  let next = reactor;
  const flipped: Flip[] = [];

  for (const key of keys) {
    const before = next.registrations.get(key);
    if (!before) continue;

    next = register(next, key, before.expr, env);
    const after = next.registrations.get(key)!;

    if (after.evaluation.truth !== before.evaluation.truth) {
      flipped.push({
        key,
        from: before.evaluation.truth,
        to: after.evaluation.truth,
      });
    }
  }

  return { reactor: next, flipped };
};

/** `affected` then `refresh`: the ordinary path when something changes. */
export const react = (
  reactor: Reactor,
  changed: ReadonlyArray<string>,
  env: Evaluate.Env
): {
  readonly reactor: Reactor;
  readonly considered: ReadonlyArray<string>;
  readonly flipped: ReadonlyArray<Flip>;
} => {
  const considered = affected(reactor, changed);
  const { reactor: next, flipped } = refresh(reactor, considered, env);
  return { reactor: next, considered, flipped };
};
