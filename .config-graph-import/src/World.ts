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
 * **Values are observed by digest, never in the clear.** An evaluation that
 * read an SSN records that `employee/ssn` was present with digest `sha256-...`,
 * not the number. Comparison still works, because a digest changes exactly when
 * the value does, so the cache is unaffected. What changes is that a persisted
 * decision - the very record you most want to hand an auditor - stops being a
 * second copy of the data it was made from.
 *
 * This is not encryption, and it should not be sold as such. A digest over a
 * three-option enum is trivially reversed by trying all three; it is only
 * meaningful over a value with real entropy. What it buys unconditionally is
 * that the record holds no plaintext, and that anyone with a candidate value
 * can *prove* it was the one used without the record ever containing it.
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

/**
 * The entity a rule means when it says "this one".
 *
 * A compliance rule is about *an* employee, not about `ee_1`. Baking a
 * particular id into the expression would mint a separate rule per person -
 * a thousand config objects saying the same thing, each versioned and diffed
 * on its own, and no way to ask "did the I-9 rule change".
 *
 * So reads may name this sentinel and evaluation substitutes the subject.
 * Crucially the substitution happens at evaluation, not at construction: the
 * rule's content id stays subject-free, so it is ONE object in the graph, while
 * each decision's id differs because its observations name the real entity.
 * One rule, many proofs.
 */
export const SUBJECT = "$subject";

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
      /**
       * A config node this evaluation resolved, addressed by content. `cid` is
       * null when the catalog had no such node - absence is a dependency here
       * for the same reason it is for facts, so publishing a missing rule
       * invalidates the answers that noticed it was missing.
       */
      readonly _tag: "Config";
      readonly kind: string;
      readonly key: string;
      readonly cid: ContentId.ContentId | null;
    }
  | {
      readonly _tag: "Fact";
      readonly entity: string;
      readonly attribute: string;
      readonly present: boolean;
      /** Digest of the value, not the value. See the note above. */
      readonly digest?: ContentId.ContentId;
    }
  | {
      readonly _tag: "Clock";
      readonly granularity: Granularity;
      readonly bucket: number;
    };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const encodeObserved = (o: Observed): CanonicalJson.CanonicalValue =>
  o._tag === "Config"
    ? { _tag: "Config", kind: o.kind, key: o.key, cid: o.cid }
    : o._tag === "Fact"
      ? {
          _tag: "Fact",
          entity: o.entity,
          attribute: o.attribute,
          present: o.present,
          digest: o.present ? o.digest : undefined,
        }
      : { _tag: "Clock", granularity: o.granularity, bucket: o.bucket };

/** Identity of an observation, used to dedupe and to order the closure. */
export const observedKey = (o: Observed): string =>
  o._tag === "Config"
    ? `config:${o.kind}/${o.key}`
    : o._tag === "Fact"
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

const VALUE_DOMAIN = "config-graph/fact-value";

/**
 * The digest of a fact's value.
 *
 * Domain-separated from node and type ids so a value's digest can never be
 * mistaken for, or forged from, an id in another space.
 */
export const valueDigest = (value: Value): ContentId.ContentId =>
  ContentId.hash(VALUE_DOMAIN, CanonicalJson.encodeOrThrow(value));

/** Observe a fact without retaining its value. */
export const observe = (
  world: World,
  entity: string,
  attribute: string
): Observed => {
  const value = read(world, entity, attribute);
  return value === undefined
    ? { _tag: "Fact", entity, attribute, present: false }
    : { _tag: "Fact", entity, attribute, present: true, digest: valueDigest(value) }; // prettier-ignore
};

/**
 * Does a candidate value match what an observation recorded?
 *
 * The verification direction. Someone holding a decision and a proposed value
 * can confirm the decision was made from that value; nobody holding only the
 * decision can recover it.
 */
export const matches = (observed: Observed, value: Value): boolean =>
  observed._tag === "Fact" &&
  observed.present &&
  observed.digest === valueDigest(value);
