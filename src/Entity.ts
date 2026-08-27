/**
 * Declarative projectors: what kinds of node exist, how each is keyed, and how
 * they relate.
 *
 * `ConfigNode.makeTyped` is the mechanism, and calling it directly works, but
 * it leaves the interesting parts stringly-typed. A projector written by hand
 * says `kind: "attribute"` and takes `key: string`, so nothing stops a form key
 * being passed where an attribute key belongs, or a `kind` drifting out of sync
 * with the entity it names. Both mistakes produce a graph that hashes
 * perfectly well and only fails later, at commit time, as a `DanglingRefError`.
 *
 * An `Entity` moves those decisions into one declaration and lets the compiler
 * hold them. `kind` comes from the entity rather than a literal at each call
 * site. Keys are branded per entity, so `EntityKey<"attribute">` and
 * `EntityKey<"form">` are not interchangeable. Nodes are branded the same way,
 * so nesting a policy where a page belongs does not compile.
 *
 * The field vocabulary is the important part, and it is deliberately two words
 * rather than a general resolver:
 *
 * - `Entity.children(PageKind)` composes: the child is nested and its `cid`
 *   flows into the parent's, so an edit anywhere beneath bubbles up.
 * - `Entity.ref(AttributeKind)` depends: only the target's kind and key are
 *   recorded, and whether the target itself moved is a question for
 *   `closureId`.
 *
 * That is exactly the children/refs asymmetry `ConfigNode` already enforces;
 * naming it as a field kind is what makes it visible at the point of
 * declaration instead of buried in a call to `makeTyped`.
 *
 * Fields target a `Kind` token rather than the entity itself. The obvious
 * design is a lazy `() => Automation`, but it does not survive contact with
 * the cycle this graph actually has: inferring `Form` needs `Automation`, which
 * needs `Action`, which needs `Form`, and TypeScript gives up with an implicit
 * `any` no thunk can defer. Declaring kinds up front breaks that, and nothing
 * is lost - the graph only ever records a target's kind and key, so the entity
 * behind it is never needed to build a node. A `Kind` is also where the key
 * brand lives, which means a key can be named without its entity in scope.
 *
 * There is no `Entity.effect` or `Entity.stream` here on purpose. Configuration
 * is finite and a snapshot is immutable, so a field that resolves at read time
 * or emits over time would contradict the thing being built. Fetching belongs
 * upstream, in whatever reads the database to call these projectors.
 */

import { Effect, ParseResult } from "effect";

import * as CanonicalJson from "./CanonicalJson";
import * as ConfigNode from "./ConfigNode";
import * as TypeExpr from "./TypeExpr";

declare const KindBrand: unique symbol;

/**
 * A node's semantic key, branded by the kind it addresses.
 *
 * The brand is the point. `employee.ssn` and `i9` are both strings, and the
 * whole design rests on keys being semantic rather than row ids, so the type
 * system is the only thing that can keep the two apart at a call site.
 */
export type EntityKey<Kind extends string> = string & {
  readonly [KindBrand]: Kind;
};

/** A `ConfigNode` known to have been produced by a particular entity. */
export type EntityNode<Kind extends string> = ConfigNode.ConfigNode & {
  readonly [KindBrand]: Kind;
};

/**
 * The name of a node kind, plus the brand for keys that address it. Declare
 * these before the entities so relations between them can be written in any
 * order, including circularly.
 */
export interface Kind<K extends string> {
  readonly name: K;
  /** Brand a key that addresses this kind. */
  readonly key: (raw: string) => EntityKey<K>;
}

export const kind = <K extends string>(name: K): Kind<K> => ({
  name,
  key: (raw) => raw as EntityKey<K>,
});

export interface ChildField<K extends string> {
  readonly _tag: "Child";
  readonly target: Kind<K>;
}

export interface RefField<K extends string> {
  readonly _tag: "Ref";
  readonly target: Kind<K>;
}

/** Nested and hashed: the child's `cid` flows into the parent's. */
export const children = <K extends string>(target: Kind<K>): ChildField<K> => ({
  _tag: "Child",
  target,
});

/** Recorded by kind and key only; cycles are fine, `closureId` covers drift. */
export const ref = <K extends string>(target: Kind<K>): RefField<K> => ({
  _tag: "Ref",
  target,
});

type ChildFields = Record<string, ChildField<string>>;
type RefFields = Record<string, RefField<string>>;

type KindOf<F> = F extends ChildField<infer K> ? K : F extends RefField<infer K> ? K : never; // prettier-ignore

export interface NodeInput<I, C extends ChildFields, R extends RefFields> {
  readonly attrs: I;
  readonly children?: {
    readonly [K in keyof C]?: ReadonlyArray<EntityNode<KindOf<C[K]>>>;
  };
  readonly refs?: {
    readonly [K in keyof R]?: ReadonlyArray<EntityKey<KindOf<R[K]>>>;
  };
}

export interface Entity<
  K extends string,
  I,
  C extends ChildFields,
  R extends RefFields,
> {
  readonly kind: Kind<K>;
  readonly attrs: TypeExpr.TypeExpr;
  readonly childFields: C;
  readonly refFields: R;

  /**
   * Derive this node's key from its own data. One home for the rule, so
   * "semantic, never a row id" is enforced rather than remembered.
   */
  readonly keyOf: (attrs: I) => EntityKey<K>;

  /** Brand a key that already exists, e.g. read back out of the store. */
  readonly key: (raw: string) => EntityKey<K>;

  readonly node: (
    input: NodeInput<I, C, R>
  ) => Effect.Effect<
    EntityNode<K>,
    | ConfigNode.DuplicateChildKeyError
    | CanonicalJson.CanonicalEncodingError
    | ParseResult.ParseError
  >;
}

export const make = <
  K extends string,
  I,
  const C extends ChildFields = {},
  const R extends RefFields = {},
>(definition: {
  readonly kind: Kind<K>;
  readonly attrs: TypeExpr.TypeExpr;
  readonly key: (attrs: I) => string;
  readonly children?: C;
  readonly refs?: R;
}): Entity<K, I, C, R> => {
  const childFields = (definition.children ?? {}) as C;
  const refFields = (definition.refs ?? {}) as R;

  const entity: Entity<K, I, C, R> = {
    kind: definition.kind,
    attrs: definition.attrs,
    childFields,
    refFields,
    keyOf: (attrs) => definition.key(attrs) as EntityKey<K>,
    key: definition.kind.key,
    node: (input) =>
      Effect.gen(function* () {
        // Relations are emitted in declaration order so the projector, not the
        // caller's object literal, decides child ordering - and child order is
        // content.
        const nested = Object.entries(childFields).flatMap(([rel]) =>
          (
            (input.children?.[rel] ??
              []) as ReadonlyArray<ConfigNode.ConfigNode>
          ).map((node) => ({ rel, node }))
        );

        const edges = Object.entries(refFields).flatMap(([rel, field]) =>
          ((input.refs?.[rel] ?? []) as ReadonlyArray<string>).map((key) => ({
            rel,
            kind: field.target.name,
            key,
          }))
        );

        const node = yield* ConfigNode.makeTyped({
          kind: definition.kind.name,
          key: definition.key(input.attrs),
          type: definition.attrs,
          attrs: input.attrs,
          children: nested,
          refs: edges,
        });

        return node as EntityNode<K>;
      }),
  };

  return entity;
};

/**
 * Build nodes with a different attrs type than the entity declares.
 *
 * Deploying a widened projection means running the same entity under a new
 * shape, which is the case `TypeSubsumption` exists to make cheap. Rather than
 * duplicating an entity per type generation, override the shape for one build
 * and let the store decide whether that is news.
 */
export const withType = <
  K extends string,
  I,
  C extends ChildFields,
  R extends RefFields,
>(
  entity: Entity<K, I, C, R>,
  attrs: TypeExpr.TypeExpr
): Entity<K, I, C, R> =>
  make({
    kind: entity.kind,
    attrs,
    key: (value: I) => entity.keyOf(value),
    children: entity.childFields,
    refs: entity.refFields,
  });
