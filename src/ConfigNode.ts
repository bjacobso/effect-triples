/**
 * The merkle node. A `ConfigNode` is one addressable piece of configuration -
 * a form, one of its pages, one field on that page, an automation, a policy
 * rule, an attribute definition - and its `cid` covers that node plus its
 * entire subtree.
 *
 * Three properties do the work:
 *
 * 1. **Children are hashed, refs are not.** A child (`page` inside `form`) is
 *    nested and contributes its `cid`, so a changed field bubbles up to the
 *    form. A ref (a field pointing at attribute `employee.ssn`) contributes
 *    only the target's kind and key. That asymmetry is what lets the graph
 *    contain real cycles - a form-scoped automation points back at the form
 *    that owns it - without the fixpoint problem a pure merkle DAG would hit.
 *    Whether a ref's *target* changed is answered by the closure id (see
 *    `closureId`), not by the node's own `cid`.
 *
 * 2. **Identity is semantic, never a row id.** `key` must be derived from
 *    meaning - a field's `path`, an automation node's `name`, an attribute's
 *    `entityType:path` - never from `id`, `uid`, or a `position` float. The
 *    same config copied from an org blueprint into an account, or from live
 *    mode into test mode, produces new rows with new uids; keyed by uid those
 *    would hash differently and the whole scheme would report drift where
 *    there is none. Keyed semantically they hash identically, which is what
 *    makes "is test in sync with live" a single `cid` comparison.
 *
 * 3. **Order is content, but only as ordinal.** Children keep their given
 *    order, so reordering two pages changes the form's `cid`. The `position`
 *    float that produced that order must NOT be in `attrs`: dragging a field
 *    between two others rewrites positions across the page and would otherwise
 *    dirty every sibling.
 *
 * `ENVELOPE_VERSION` is mixed into every hash. It versions the body layout
 * below - the `kind` / `key` / `attrs` / `children` / `refs` frame itself - not
 * the shape of any particular projection, and it should move roughly never.
 * The shape of a projection is versioned automatically by its `TypeExpr` id;
 * `makeTyped` and `stamp` for why the two are kept apart.
 */

import { Data, Effect, ParseResult } from "effect";

import * as CanonicalJson from "./CanonicalJson";
import * as ContentId from "./ContentId";
import * as TypeExpr from "./TypeExpr";
import * as TypeSchema from "./TypeSchema";

export const ENVELOPE_VERSION = 1;

const NODE_DOMAIN = "config-graph/node";
const CLOSURE_DOMAIN = "config-graph/closure";
const STAMP_DOMAIN = "config-graph/stamp";

export interface ConfigRef {
  /** Why the edge exists: `uses_attribute`, `scopes_form`, `creates_task`. */
  readonly rel: string;
  readonly kind: string;
  readonly key: string;
}

export interface ConfigChild {
  readonly rel: string;
  readonly node: ConfigNode;
}

export interface ConfigNode {
  readonly kind: string;
  readonly key: string;
  readonly attrs: CanonicalJson.CanonicalValue;
  readonly children: ReadonlyArray<ConfigChild>;
  readonly refs: ReadonlyArray<ConfigRef>;
  readonly cid: ContentId.ContentId;
  /**
   * The type `attrs` was validated and normalised through, when the node came
   * from `makeTyped`. Deliberately NOT part of `cid` - see `stamp`.
   */
  readonly type?: TypeExpr.TypeExpr;
}

export class DuplicateChildKeyError extends Data.TaggedError(
  "DuplicateChildKeyError"
)<{
  readonly kind: string;
  readonly key: string;
  readonly duplicate: string;
  readonly message: string;
}> {}

export class ConflictingClosureEntryError extends Data.TaggedError(
  "ConflictingClosureEntryError"
)<{
  readonly kind: string;
  readonly key: string;
  readonly message: string;
}> {}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const sortRefs = (refs: ReadonlyArray<ConfigRef>): ReadonlyArray<ConfigRef> =>
  [...refs]
    .sort(
      (a, b) => cmp(a.rel, b.rel) || cmp(a.kind, b.kind) || cmp(a.key, b.key)
    )
    // Two identical edges say nothing more than one; a field referencing the
    // same attribute from both its rule and its options is one dependency.
    .filter(
      (ref, index, all) =>
        index === 0 ||
        ref.rel !== all[index - 1].rel ||
        ref.kind !== all[index - 1].kind ||
        ref.key !== all[index - 1].key
    );

const refsValue = (
  refs: ReadonlyArray<ConfigRef>
): CanonicalJson.CanonicalValue =>
  refs.map((ref) => ({ rel: ref.rel, kind: ref.kind, key: ref.key }));

/**
 * The exact value hashed to produce `node.cid`. Persist this, not a re-derived
 * shape: the store's job is to hold the bytes the id was computed over.
 */
export const body = (node: {
  readonly kind: string;
  readonly key: string;
  readonly attrs: CanonicalJson.CanonicalValue;
  readonly children: ReadonlyArray<ConfigChild>;
  readonly refs: ReadonlyArray<ConfigRef>;
}): CanonicalJson.CanonicalValue => ({
  v: ENVELOPE_VERSION,
  kind: node.kind,
  key: node.key,
  attrs: node.attrs,
  children: node.children.map((child) => ({
    rel: child.rel,
    cid: child.node.cid,
  })),
  refs: refsValue(node.refs),
});

export const make = (input: {
  readonly kind: string;
  readonly key: string;
  readonly attrs?: CanonicalJson.CanonicalValue;
  readonly children?: ReadonlyArray<ConfigChild>;
  readonly refs?: ReadonlyArray<ConfigRef>;
}): Effect.Effect<
  ConfigNode,
  DuplicateChildKeyError | CanonicalJson.CanonicalEncodingError
> =>
  Effect.gen(function* () {
    const children = input.children ?? [];
    const refs = sortRefs(input.refs ?? []);

    // Children are aligned by (rel, key) when diffing. A duplicate makes that
    // alignment ambiguous, so the diff would report churn on unchanged nodes.
    const seen = new Set<string>();
    for (const child of children) {
      const slot = `${child.rel} ${child.node.key}`;
      if (seen.has(slot)) {
        return yield* new DuplicateChildKeyError({
          kind: input.kind,
          key: input.key,
          duplicate: `${child.rel}:${child.node.key}`,
          message: `${input.kind} "${input.key}" has two children at ${child.rel}:${child.node.key}; child keys must be unique within a relation`,
        });
      }
      seen.add(slot);
    }

    const draft = {
      kind: input.kind,
      key: input.key,
      attrs: input.attrs ?? {},
      children,
      refs,
    };
    const encoded = yield* CanonicalJson.encode(body(draft));

    return { ...draft, cid: ContentId.hash(NODE_DOMAIN, encoded) };
  });

/**
 * `make`, with `attrs` validated and normalised through an Effect Schema.
 *
 * This is the intended way to build every projection. The type does three
 * jobs at once: it rejects a projector that drifts from the shape it claims to
 * emit, it normalises the data so irrelevant differences cannot move the hash
 * (see `TypeSchema.normalize`), and it records the type itself, so the store
 * can log which shape wrote which object.
 */
export const makeTyped = (input: {
  readonly kind: string;
  readonly key: string;
  readonly type: TypeExpr.TypeExpr;
  readonly attrs: unknown;
  readonly children?: ReadonlyArray<ConfigChild>;
  readonly refs?: ReadonlyArray<ConfigRef>;
}): Effect.Effect<
  ConfigNode,
  | DuplicateChildKeyError
  | CanonicalJson.CanonicalEncodingError
  | ParseResult.ParseError
> =>
  Effect.gen(function* () {
    const attrs = yield* TypeSchema.normalize(input.type, input.attrs);
    const node = yield* make({
      ...input,
      attrs: attrs as CanonicalJson.CanonicalValue,
    });
    return { ...node, type: input.type };
  });

/**
 * The id of a node *as produced by a particular set of projectors*: its data id
 * combined with every schema used anywhere in its subtree.
 *
 * Snapshots pin stamps, not bare `cid`s, so a snapshot is reproducible - it
 * records both what the config said and how it was read. But `cid` itself stays
 * schema-free on purpose. Adding one optional field to a projection schema
 * would otherwise change the id of every object of that kind, and the deploy UI
 * would show ten thousand forms as "changed" when none of them were. Keeping
 * the two apart lets that render as what it is: no data changes, one new
 * projector shape.
 *
 * The subtree matters rather than just the root: a form's own attrs are written
 * by one schema, but its pages and fields are written by others, and a widened
 * *field* schema has to be visible on the form that contains it. Distinct
 * schemas are collected as a sorted set, so two fields sharing a shape count
 * once and reordering them does not move the stamp.
 */
export const stamp = (
  node: ConfigNode
): Effect.Effect<ContentId.ContentId, CanonicalJson.CanonicalEncodingError> =>
  Effect.gen(function* () {
    const encoded = yield* CanonicalJson.encode({
      v: ENVELOPE_VERSION,
      cid: node.cid,
      schemas: typeIds(node),
    });
    return ContentId.hash(STAMP_DOMAIN, encoded);
  });

/**
 * Every distinct projection type used anywhere in the subtree, sorted.
 *
 * Stored alongside a revision so "a projector changed" is answerable on its own
 * rather than only as a stamp that differs for some unstated reason.
 */
export const typeIds = (
  node: ConfigNode
): ReadonlyArray<ContentId.ContentId> => {
  const found = new Set<ContentId.ContentId>();
  for (const { node: nested } of walk(node)) {
    if (nested.type) found.add(TypeExpr.id(nested.type));
  }
  return [...found].sort(cmp);
};

export interface ClosureEntry {
  readonly kind: string;
  readonly key: string;
  readonly cid: ContentId.ContentId;
}

/**
 * The id of a node *together with everything it depends on*.
 *
 * `node.cid` answers "did this form change?". `closureId` answers "would this
 * form behave differently?" - it changes when a referenced attribute is
 * retyped or a referenced policy is edited, even though the form's own bytes
 * are untouched. That is the question the current per-object version numbers
 * cannot answer at all.
 *
 * Deps carry their *content* ids, not their closure ids. That keeps the
 * computation a single pass over a set instead of a fixpoint over a graph, and
 * it terminates on cycles. The cost is that a change two hops away only moves
 * the closure id if the intermediate object is also in `deps`, so callers must
 * pass the transitive dependency set, not the direct one.
 */
export const closureId = (
  node: ConfigNode,
  deps: Iterable<ClosureEntry>
): Effect.Effect<
  ContentId.ContentId,
  ConflictingClosureEntryError | CanonicalJson.CanonicalEncodingError
> =>
  Effect.gen(function* () {
    const byKey = new Map<string, ClosureEntry>();
    for (const dep of deps) {
      const slot = `${dep.kind} ${dep.key}`;
      const existing = byKey.get(slot);
      if (existing && existing.cid !== dep.cid) {
        return yield* new ConflictingClosureEntryError({
          kind: dep.kind,
          key: dep.key,
          message: `closure for ${node.kind} "${node.key}" got two content ids for ${dep.kind}:${dep.key}`,
        });
      }
      byKey.set(slot, dep);
    }

    const sorted = [...byKey.values()].sort(
      (a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key)
    );

    const encoded = yield* CanonicalJson.encode({
      v: ENVELOPE_VERSION,
      root: node.cid,
      deps: sorted.map((dep) => ({
        kind: dep.kind,
        key: dep.key,
        cid: dep.cid,
      })),
    });

    return ContentId.hash(CLOSURE_DOMAIN, encoded);
  });

/** Depth-first walk, parents before children. */
export function* walk(
  node: ConfigNode,
  path = ""
): Generator<{ readonly node: ConfigNode; readonly path: string }> {
  const here = path === "" ? node.key : path;
  yield { node, path: here };
  for (const child of node.children) {
    yield* walk(child.node, `${here}/${child.rel}:${child.node.key}`);
  }
}

/**
 * Every distinct node in the subtree, keyed by cid. Identical subtrees collapse
 * to one entry - two forms sharing a page, or the same form in live and test
 * mode, store those bytes once.
 */
export const flatten = (
  node: ConfigNode
): ReadonlyMap<ContentId.ContentId, ConfigNode> => {
  const out = new Map<ContentId.ContentId, ConfigNode>();
  const visit = (current: ConfigNode): void => {
    if (out.has(current.cid)) return;
    out.set(current.cid, current);
    current.children.forEach((child) => visit(child.node));
  };
  visit(node);
  return out;
};

export type ConfigChange =
  | {
      readonly _tag: "Added";
      readonly path: string;
      readonly kind: string;
      readonly cid: ContentId.ContentId;
    }
  | {
      readonly _tag: "Removed";
      readonly path: string;
      readonly kind: string;
      readonly cid: ContentId.ContentId;
    }
  | {
      readonly _tag: "Changed";
      readonly path: string;
      readonly kind: string;
      readonly from: ContentId.ContentId;
      readonly to: ContentId.ContentId;
      readonly attrsChanged: boolean;
      readonly refsChanged: boolean;
      /** True when children kept their keys but moved position. */
      readonly reordered: boolean;
    };

const encodedOf = (value: CanonicalJson.CanonicalValue): string =>
  // Safe: every node encoded successfully in `make`.
  CanonicalJson.encodeOrThrow(value);

/**
 * Structural diff of two subtrees.
 *
 * This is the whole point of the merkle shape: an unchanged subtree is
 * recognised by one string comparison, so diffing an account with a hundred
 * thousand config nodes costs work proportional to what actually changed. The
 * current whole-export SHA-256 on `task_templates.hash_digest` can only say
 * "different" - it cannot say where.
 */
export const diff = (
  before: ConfigNode,
  after: ConfigNode,
  path = ""
): ReadonlyArray<ConfigChange> => {
  const here = path === "" ? after.key : path;
  if (before.cid === after.cid) return [];

  const beforeChildren = new Map(
    before.children.map((child, index) => [
      `${child.rel} ${child.node.key}`,
      { child, index },
    ])
  );
  const afterChildren = new Map(
    after.children.map((child, index) => [
      `${child.rel} ${child.node.key}`,
      { child, index },
    ])
  );

  const changes: ConfigChange[] = [];
  let reordered = false;

  for (const [slot, { child, index }] of afterChildren) {
    const previous = beforeChildren.get(slot);
    const childPath = `${here}/${child.rel}:${child.node.key}`;
    if (!previous) {
      changes.push({
        _tag: "Added",
        path: childPath,
        kind: child.node.kind,
        cid: child.node.cid,
      });
      continue;
    }
    if (previous.index !== index) reordered = true;
    changes.push(...diff(previous.child.node, child.node, childPath));
  }

  for (const [slot, { child }] of beforeChildren) {
    if (afterChildren.has(slot)) continue;
    changes.push({
      _tag: "Removed",
      path: `${here}/${child.rel}:${child.node.key}`,
      kind: child.node.kind,
      cid: child.node.cid,
    });
  }

  changes.unshift({
    _tag: "Changed",
    path: here,
    kind: after.kind,
    from: before.cid,
    to: after.cid,
    attrsChanged: encodedOf(before.attrs) !== encodedOf(after.attrs),
    refsChanged:
      encodedOf(refsValue(before.refs)) !== encodedOf(refsValue(after.refs)),
    reordered,
  });

  return changes;
};
