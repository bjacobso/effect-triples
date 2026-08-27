/**
 * The facts an evaluation reads, and the clock it reads them at.
 *
 * A world is deliberately not content-addressed as a whole. Hashing every fact
 * an account has would make one submitted value invalidate every cached
 * evaluation in the system, which is the naive design and the wrong one. What
 * gets addressed is the **closure**: the facts an evaluation actually observed.
 * That set is not knowable before evaluating, so it is discovered during
 * evaluation and recorded - the same shape as a build system with dynamic
 * dependencies.
 *
 * Two things here are load-bearing and easy to get wrong.
 *
 * **Absence is a dependency.** "This employee has no work authorization on
 * file" is a conclusion drawn from a fact that is not there. If absence is not
 * recorded, adding the missing fact leaves a stale cached answer that says the
 * requirement is still unmet. So a read of a missing fact observes
 * `present: false` and participates in the closure exactly like a present one.
 *
 * **The clock is an input, not ambient.** An expression asking "is the start
 * date in the past" is not a function of the facts alone, and an evaluator that
 * reaches for `Date.now()` produces a result that cannot honestly be cached
 * against its inputs. Time therefore arrives as a value, with a declared
 * granularity, and what is observed is the *bucket* rather than the instant.
 * A question about days depends on the day; it should not be invalidated a
 * thousand times a second.
 */

import * as CanonicalJson from "./CanonicalJson";
import * as ContentId from "./ContentId";

export type Value = string | number | boolean;

/** Facts, keyed by entity and attribute. One value per pair. */
export interface World {
  readonly facts: ReadonlyMap<string, Value>;
}

export type Granularity = "instant" | "day";

export interface Clock {
  readonly now: number;
  /**
   * How finely an expression may observe the clock. `day` buckets to the UTC
   * day, so a cached answer survives until the day turns.
   */
  readonly granularity: Granularity;
}

const DAY_MS = 86_400_000;

export const bucket = (clock: Clock): number =>
  clock.granularity === "day" ? Math.floor(clock.now / DAY_MS) : clock.now;

export const factKey = (entity: string, attribute: string): string =>
  `${entity}/${attribute}`;

export const make = (facts: Readonly<Record<string, Value>>): World => ({
  facts: new Map(Object.entries(facts)),
});

export const withFact = (
  world: World,
  entity: string,
  attribute: string,
  value: Value
): World => {
  const facts = new Map(world.facts);
  facts.set(factKey(entity, attribute), value);
  return { facts };
};

export const withoutFact = (
  world: World,
  entity: string,
  attribute: string
): World => {
  const facts = new Map(world.facts);
  facts.delete(factKey(entity, attribute));
  return { facts };
};

export const read = (
  world: World,
  entity: string,
  attribute: string
): Value | undefined => world.facts.get(factKey(entity, attribute));

/**
 * One thing an evaluation looked at. The union is the point: a clock reading is
 * a dependency in exactly the same sense as a fact, and a *missing* fact is a
 * dependency in exactly the same sense as a present one.
 */
export type Observed =
  | {
      readonly _tag: "Fact";
      readonly entity: string;
      readonly attribute: string;
      readonly present: boolean;
      readonly value?: Value;
    }
  | {
      readonly _tag: "Clock";
      readonly granularity: Granularity;
      readonly bucket: number;
    };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const encodeObserved = (o: Observed): CanonicalJson.CanonicalValue =>
  o._tag === "Fact"
    ? {
        _tag: "Fact",
        entity: o.entity,
        attribute: o.attribute,
        present: o.present,
        value: o.present ? o.value : undefined,
      }
    : { _tag: "Clock", granularity: o.granularity, bucket: o.bucket };

/** Identity of an observation, used to dedupe and to order the closure. */
export const observedKey = (o: Observed): string =>
  o._tag === "Fact"
    ? `fact:${o.entity}/${o.attribute}`
    : `clock:${o.granularity}`;

/**
 * The digest of everything an evaluation depended on.
 *
 * This is the cache key's other half. Observations are deduped by key and
 * sorted, so the order an expression happened to read things in is not content.
 */
export const closureId = (
  observed: ReadonlyArray<Observed>
): ContentId.ContentId => {
  const byKey = new Map<string, Observed>();
  for (const o of observed) byKey.set(observedKey(o), o);
  const sorted = [...byKey.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([, o]) => encodeObserved(o));
  return ContentId.hash(
    "config-graph/closure-facts",
    CanonicalJson.encodeOrThrow(sorted)
  );
};

/**
 * Re-observe a previously recorded dependency set against a world and clock.
 *
 * This is what makes a dynamic-dependency cache work: you cannot know the key
 * before evaluating, but you can replay *last time's* keys cheaply and see
 * whether they still produce the same digest.
 */
export const reobserve = (
  observed: ReadonlyArray<Observed>,
  world: World,
  clock: Clock
): ReadonlyArray<Observed> =>
  observed.map((o) => {
    if (o._tag === "Clock") {
      return { _tag: "Clock", granularity: o.granularity, bucket: bucket({ now: clock.now, granularity: o.granularity }) }; // prettier-ignore
    }
    const value = read(world, o.entity, o.attribute);
    return value === undefined
      ? { _tag: "Fact", entity: o.entity, attribute: o.attribute, present: false } // prettier-ignore
      : { _tag: "Fact", entity: o.entity, attribute: o.attribute, present: true, value }; // prettier-ignore
  });
