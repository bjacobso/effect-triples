/**
 * An in-memory content-addressed store, revision log and snapshot history.
 *
 * This is the reference implementation of the semantics the Postgres tables
 * will have to honour, kept in memory so the whole model can be exercised and
 * argued about before any migration is written. The mapping is one-to-one:
 * `objects` is `config_objects`, `schemas` is `config_schemas`, `revisions` is
 * `config_revisions`, `snapshots` is `config_snapshots`, and `refs` is
 * `config_refs` - git-style pointers where deploying is moving a ref and
 * rolling back is moving it back.
 *
 * Everything here is pure. `commit` returns a new store rather than mutating
 * one, and ids come from a sequence counter rather than a clock, so a scenario
 * replays to byte-identical hashes every run. That is not a testing
 * convenience: a versioning system whose ids depend on when it ran cannot tell
 * you whether two deploys shipped the same configuration.
 *
 * Three behaviours are worth knowing before reading the code.
 *
 * **Revisions are reused, not rewritten.** Committing a snapshot where only one
 * form changed does not mint new revisions for the untouched policy and
 * automation - it points the new snapshot at the revisions they already had.
 * A revision is only superseded when its data, its schema, or its closure moved.
 *
 * **Dangling refs fail the commit.** If a form references `employee.ssn` and
 * that attribute is not in the snapshot, the commit fails rather than recording
 * a configuration that cannot run. This is the check that catches a deleted
 * attribute still referenced by a live automation, which today surfaces as a
 * runtime error against a real employee.
 *
 * **A snapshot is itself a `ConfigNode`.** Its children are the objects, so
 * `ConfigNode.diff` works on two snapshots unchanged and the merkle shape means
 * comparing two large snapshots costs work proportional to what differs. Its
 * key is a constant and its label lives outside the hash, so a snapshot's id is
 * the identity of the configuration and nothing else: two releases that ship
 * identical config share a root id whatever they were named, and whichever
 * version of the projector code happened to read them.
 */

import { Data, Effect } from "effect";

import * as CanonicalJson from "../content/CanonicalJson";
import * as ConfigNode from "./ConfigNode";
import * as ContentId from "../content/ContentId";
import * as TypeExpr from "./TypeExpr";
import * as TypeSchema from "./TypeSchema";
import * as TypeSubsumption from "./TypeSubsumption";

export interface StoredObject {
  readonly cid: ContentId.ContentId;
  readonly kind: string;
  /** Exactly the value that was hashed. */
  readonly body: CanonicalJson.CanonicalValue;
  /**
   * Every schema this exact body is known to satisfy, not just the one that
   * wrote it. Grows monotonically: when a new shape is deployed and proven to
   * subsume one already in this set, the body is revalidated for free.
   *
   * Content addressing makes this cheap in the way that matters. Two hundred
   * forms sharing an identical field body share one entry, so the set is
   * maintained per distinct configuration rather than per occurrence of it.
   */
  readonly validUnder: ReadonlyArray<ContentId.ContentId>;
}

export interface ObjectKey {
  readonly kind: string;
  readonly key: string;
}

export interface Revision {
  readonly id: string;
  readonly seq: number;
  readonly kind: string;
  readonly key: string;
  /** Identity of the data alone. */
  readonly cid: ContentId.ContentId;
  /** Every distinct projection schema used in the subtree, sorted. */
  readonly schemaCids: ReadonlyArray<ContentId.ContentId>;
  /** `cid` + `schemaCids`: what a snapshot pins. */
  readonly stamp: ContentId.ContentId;
  /** `cid` + the content ids of everything it transitively depends on. */
  readonly closureCid: ContentId.ContentId;
  readonly deps: ReadonlyArray<ObjectKey>;
  /** The revision this one superseded, or null for the first. */
  readonly parentId: string | null;
}

export interface ConfigSnapshot {
  readonly id: string;
  readonly seq: number;
  readonly label: string;
  readonly rootCid: ContentId.ContentId;
  /** Retained so `ConfigNode.diff` can walk two snapshots directly. */
  readonly root: ConfigNode.ConfigNode;
  readonly revisionIds: ReadonlyArray<string>;
  readonly parentId: string | null;
}

export interface InMemoryConfigStore {
  readonly objects: ReadonlyMap<ContentId.ContentId, StoredObject>;
  /** Append-only log of every projection shape ever used. */
  readonly schemas: ReadonlyMap<ContentId.ContentId, TypeExpr.TypeExpr>;
  readonly revisions: ReadonlyArray<Revision>;
  readonly snapshots: ReadonlyArray<ConfigSnapshot>;
  /** Ref name (`live`, `test`) to snapshot id. */
  readonly refs: ReadonlyMap<string, string>;
  readonly seq: number;
}

export class DanglingRefError extends Data.TaggedError("DanglingRefError")<{
  readonly from: ObjectKey;
  readonly to: ObjectKey;
  readonly message: string;
}> {}

export class DuplicateObjectError extends Data.TaggedError("DuplicateObjectError")<{
  readonly object: ObjectKey;
  readonly message: string;
}> {}

export class UnknownSnapshotError extends Data.TaggedError("UnknownSnapshotError")<{
  readonly id: string;
  readonly message: string;
}> {}

const SNAPSHOT_KIND = "snapshot";
/** Constant: the release label must not leak into the configuration's id. */
const SNAPSHOT_ROOT_KEY = "config";

const slotOf = (object: ObjectKey) => `${object.kind} ${object.key}`;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const empty = (): InMemoryConfigStore => ({
  objects: new Map(),
  schemas: new Map(),
  revisions: [],
  snapshots: [],
  refs: new Map(),
  seq: 0,
});

/** Newest-first revision chain for one logical object. */
export const historyOf = (store: InMemoryConfigStore, object: ObjectKey): ReadonlyArray<Revision> =>
  store.revisions
    .filter((rev) => rev.kind === object.kind && rev.key === object.key)
    .sort((a, b) => b.seq - a.seq);

export const tipOf = (store: InMemoryConfigStore, object: ObjectKey): Revision | undefined =>
  historyOf(store, object)[0];

export const revisionById = (store: InMemoryConfigStore, id: string): Revision | undefined =>
  store.revisions.find((rev) => rev.id === id);

export const snapshotById = (store: InMemoryConfigStore, id: string): ConfigSnapshot | undefined =>
  store.snapshots.find((snap) => snap.id === id);

export const resolveRef = (
  store: InMemoryConfigStore,
  name: string,
): ConfigSnapshot | undefined => {
  const id = store.refs.get(name);
  return id === undefined ? undefined : snapshotById(store, id);
};

/**
 * Point a ref at a snapshot. This is the entire deploy primitive: promoting a
 * snapshot to live and rolling back to the previous one are the same operation
 * in opposite directions, and neither copies or rewrites any configuration.
 */
export const setRef = (
  store: InMemoryConfigStore,
  name: string,
  snapshotId: string,
): Effect.Effect<InMemoryConfigStore, UnknownSnapshotError> =>
  Effect.gen(function* () {
    if (!snapshotById(store, snapshotId)) {
      return yield* new UnknownSnapshotError({
        id: snapshotId,
        message: `Cannot point ref "${name}" at unknown snapshot ${snapshotId}`,
      });
    }
    return { ...store, refs: new Map(store.refs).set(name, snapshotId) };
  });

/**
 * Every object reachable from `start` by following refs, excluding itself.
 * Cycle-safe: a form that scopes an automation which creates a task from that
 * same form yields each exactly once.
 */
const transitiveDeps = (
  start: ConfigNode.ConfigNode,
  bySlot: ReadonlyMap<string, ConfigNode.ConfigNode>,
): Effect.Effect<ReadonlyArray<ObjectKey>, DanglingRefError> =>
  Effect.gen(function* () {
    const found = new Map<string, ObjectKey>();
    const queue: ConfigNode.ConfigNode[] = [start];
    const visited = new Set<string>([slotOf(start)]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      // Refs can sit on any node in the subtree - a single field is what
      // actually points at an attribute - so collect from the whole walk.
      for (const { node } of ConfigNode.walk(current)) {
        for (const ref of node.refs) {
          const slot = slotOf(ref);
          const target = bySlot.get(slot);
          if (!target) {
            return yield* new DanglingRefError({
              from: { kind: current.kind, key: current.key },
              to: { kind: ref.kind, key: ref.key },
              message: `${current.kind} "${current.key}" references ${ref.kind} "${ref.key}", which is not in this snapshot`,
            });
          }
          if (slot !== slotOf(start)) found.set(slot, { kind: ref.kind, key: ref.key }); // prettier-ignore
          if (visited.has(slot)) continue;
          visited.add(slot);
          queue.push(target);
        }
      }
    }

    return [...found.values()].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key));
  });

export interface CommitResult {
  readonly store: InMemoryConfigStore;
  readonly snapshot: ConfigSnapshot;
  /** Revisions minted by this commit; unchanged objects are absent. */
  readonly created: ReadonlyArray<Revision>;
}

/**
 * Record a complete set of objects as one snapshot.
 *
 * The whole set is required, not a delta. That is the point of the exercise:
 * a form is only meaningful alongside the attributes it reads, the policy that
 * distributes it and the automations it triggers, so the unit that gets
 * versioned and deployed is the graph, not the form.
 */
export const commit = (
  store: InMemoryConfigStore,
  input: {
    readonly label: string;
    readonly objects: ReadonlyArray<ConfigNode.ConfigNode>;
  },
): Effect.Effect<
  CommitResult,
  | DanglingRefError
  | DuplicateObjectError
  | ConfigNode.DuplicateChildKeyError
  | ConfigNode.ConflictingClosureEntryError
  | CanonicalJson.CanonicalEncodingError
> =>
  Effect.gen(function* () {
    const bySlot = new Map<string, ConfigNode.ConfigNode>();
    for (const object of input.objects) {
      const slot = slotOf(object);
      if (bySlot.has(slot)) {
        return yield* new DuplicateObjectError({
          object: { kind: object.kind, key: object.key },
          message: `ConfigSnapshot "${input.label}" contains ${object.kind} "${object.key}" twice`,
        });
      }
      bySlot.set(slot, object);
    }

    const ordered = [...input.objects].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key));

    const objects = new Map(store.objects);
    const schemas = new Map(store.schemas);
    const revisions = [...store.revisions];
    const created: Revision[] = [];
    let seq = store.seq;

    const revisionIds: string[] = [];

    for (const object of ordered) {
      // Whether the projector shapes this release introduced are ones the
      // existing bodies already satisfy. Starts true and only falls.
      let schemasCompatible = true;

      // Content-address every node in the subtree. Identical subtrees across
      // objects, modes or accounts collapse onto one entry.
      for (const { node } of ConfigNode.walk(object)) {
        const existing = objects.get(node.cid);
        const stored: StoredObject = existing ?? {
          cid: node.cid,
          kind: node.kind,
          body: ConfigNode.body(node),
          validUnder: [],
        };

        if (node.type) {
          const typeId = TypeExpr.id(node.type);
          if (!schemas.has(typeId)) schemas.set(typeId, node.type);

          if (!stored.validUnder.includes(typeId)) {
            // `makeTyped` validated this body against this type on the way in,
            // so it is valid by construction whatever the old shapes said. The
            // question is only whether that is *news*.
            const known = stored.validUnder
              .map((cid) => schemas.get(cid))
              .filter((t): t is TypeExpr.TypeExpr => t !== undefined);
            const provenCompatible = known.some((from) =>
              TypeSubsumption.isCompatible(TypeSubsumption.subsumes(from, node.type!)),
            );
            if (known.length > 0 && !provenCompatible) {
              schemasCompatible = false;
            }

            objects.set(node.cid, {
              ...stored,
              validUnder: [...stored.validUnder, typeId].sort(cmp),
            });
            continue;
          }
        }

        if (!existing) objects.set(node.cid, stored);
      }

      const deps = yield* transitiveDeps(object, bySlot);
      const closureCid = yield* ConfigNode.closureId(
        object,
        deps.map((dep) => ({ ...dep, cid: bySlot.get(slotOf(dep))!.cid })),
      );
      const stamp = yield* ConfigNode.stamp(object);
      const schemaCids = ConfigNode.typeIds(object);

      // A revision records what the configuration *means*, so a new projector
      // shape that provably accepts the bytes already stored is not a new
      // revision - it is another schema the same instance satisfies. Only an
      // unproven or narrowing shape reopens the question.
      const tip = tipOf({ ...store, revisions }, object);
      const unchanged =
        tip !== undefined &&
        tip.cid === object.cid &&
        tip.closureCid === closureCid &&
        (tip.stamp === stamp || schemasCompatible);

      if (unchanged) {
        revisionIds.push(tip.id);
      } else {
        seq += 1;
        const revision: Revision = {
          id: `rev_${seq}`,
          seq,
          kind: object.kind,
          key: object.key,
          cid: object.cid,
          schemaCids,
          stamp,
          closureCid,
          deps,
          parentId: tip?.id ?? null,
        };
        revisions.push(revision);
        created.push(revision);
        revisionIds.push(revision.id);
      }
    }

    // A node like any other, so diffing two releases is the ordinary merkle
    // walk. Deliberately carries no attrs: a release that only reprojects
    // unchanged config must land on the id the previous one already had.
    const root = yield* ConfigNode.make({
      kind: SNAPSHOT_KIND,
      key: SNAPSHOT_ROOT_KEY,
      children: ordered.map((node) => ({ rel: node.kind, node })),
    });

    // The root is an object too; a snapshot whose bytes are not in the store
    // would be a cid nobody can resolve.
    objects.set(root.cid, {
      cid: root.cid,
      kind: root.kind,
      body: ConfigNode.body(root),
      validUnder: [],
    });

    seq += 1;
    const parent = store.snapshots[store.snapshots.length - 1];
    const snapshot: ConfigSnapshot = {
      id: `snap_${seq}`,
      seq,
      label: input.label,
      rootCid: root.cid,
      root,
      revisionIds,
      parentId: parent?.id ?? null,
    };

    return {
      store: {
        objects,
        schemas,
        revisions,
        snapshots: [...store.snapshots, snapshot],
        refs: store.refs,
        seq,
      },
      snapshot,
      created,
    };
  });

export type ObjectChange =
  | {
      readonly _tag: "ObjectAdded";
      readonly kind: string;
      readonly key: string;
      readonly to: Revision;
    }
  | {
      readonly _tag: "ObjectRemoved";
      readonly kind: string;
      readonly key: string;
      readonly from: Revision;
    }
  | {
      readonly _tag: "ObjectChanged";
      readonly kind: string;
      readonly key: string;
      readonly from: Revision;
      readonly to: Revision;
      /** The object's own configuration moved. */
      readonly dataChanged: boolean;
      /** A different projection schema wrote it. */
      readonly schemaChanged: boolean;
      /**
       * Something it depends on moved. True with `dataChanged` false is the
       * interesting case: this object would behave differently despite nobody
       * having edited it.
       */
      readonly closureChanged: boolean;
    };

/**
 * Object-level summary of what moved between two snapshots.
 *
 * Pair it with `ConfigNode.diff(from.root, to.root)` when you need the
 * field-level detail; this answers the deploy-screen question of which objects
 * a release touches and, crucially, which it touches only indirectly.
 */
export const changesBetween = (
  store: InMemoryConfigStore,
  from: ConfigSnapshot,
  to: ConfigSnapshot,
): ReadonlyArray<ObjectChange> => {
  const revisionsOf = (snapshot: ConfigSnapshot) =>
    new Map(
      snapshot.revisionIds
        .map((id) => revisionById(store, id))
        .filter((rev): rev is Revision => rev !== undefined)
        .map((rev) => [slotOf(rev), rev] as const),
    );

  const before = revisionsOf(from);
  const after = revisionsOf(to);
  const changes: ObjectChange[] = [];

  for (const [slot, next] of after) {
    const previous = before.get(slot);
    if (!previous) {
      changes.push({
        _tag: "ObjectAdded",
        kind: next.kind,
        key: next.key,
        to: next,
      });
      continue;
    }
    if (previous.id === next.id) continue;
    changes.push({
      _tag: "ObjectChanged",
      kind: next.kind,
      key: next.key,
      from: previous,
      to: next,
      dataChanged: previous.cid !== next.cid,
      schemaChanged: previous.schemaCids.join() !== next.schemaCids.join(),
      closureChanged: previous.closureCid !== next.closureCid,
    });
  }

  for (const [slot, previous] of before) {
    if (after.has(slot)) continue;
    changes.push({
      _tag: "ObjectRemoved",
      kind: previous.kind,
      key: previous.key,
      from: previous,
    });
  }

  return changes.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key));
};

export interface RecheckResult {
  /** Bodies already known valid, or proven valid by subsumption alone. */
  readonly compatible: ReadonlyArray<ContentId.ContentId>;
  /** Bodies that needed validating and passed. */
  readonly revalidated: ReadonlyArray<ContentId.ContentId>;
  /** Bodies the candidate schema rejects. Each is config that would break. */
  readonly violations: ReadonlyArray<{
    readonly cid: ContentId.ContentId;
    readonly key: string;
  }>;
}

/**
 * Would every stored body of `kind` still parse under a candidate schema?
 *
 * This is the question worth asking in CI, before the code that narrows a
 * projection merges. Today the equivalent failure is discovered when a
 * customer's form fails to load, because nothing records which shapes the
 * stored configuration was ever known to satisfy.
 *
 * Synchronous, which it was not before: with `TypeSubsumption` total there is
 * no schema-projection step that can fail, so the only remaining work is
 * comparison and, for the last tier, decoding.
 *
 * It answers in three tiers, cheapest first. A body already listing the
 * candidate in `validUnder` costs nothing. A body whose known schema is proven
 * to subsume the candidate costs one structural comparison, amortised across
 * every body sharing that schema. Only what is left gets decoded, which is why
 * `TypeSubsumption` being total is what keeps that last tier rare.
 */
export const recheck = (
  store: InMemoryConfigStore,
  input: {
    readonly kind: string;
    readonly type: TypeExpr.TypeExpr;
  },
): RecheckResult => {
  const candidateId = TypeExpr.id(input.type);

  const compatible: ContentId.ContentId[] = [];
  const revalidated: ContentId.ContentId[] = [];
  const violations: Array<{ cid: ContentId.ContentId; key: string }> = [];

  // One verdict per known type, not per body.
  const verdicts = new Map<ContentId.ContentId, boolean>();
  const subsumesCandidate = (from: ContentId.ContentId): boolean => {
    const cached = verdicts.get(from);
    if (cached !== undefined) return cached;
    const known = store.schemas.get(from);
    const proven =
      known !== undefined &&
      TypeSubsumption.isCompatible(TypeSubsumption.subsumes(known, input.type));
    verdicts.set(from, proven);
    return proven;
  };

  for (const stored of store.objects.values()) {
    if (stored.kind !== input.kind) continue;

    if (stored.validUnder.includes(candidateId) || stored.validUnder.some(subsumesCandidate)) {
      compatible.push(stored.cid);
      continue;
    }

    const body = stored.body as { readonly attrs?: unknown; readonly key?: unknown }; // prettier-ignore
    if (TypeSchema.is(input.type, body.attrs)) {
      revalidated.push(stored.cid);
    } else {
      violations.push({
        cid: stored.cid,
        key: typeof body.key === "string" ? body.key : "<unknown>",
      });
    }
  }

  return { compatible, revalidated, violations };
};

/** Schemas this exact body is known to satisfy. */
export const validityOf = (
  store: InMemoryConfigStore,
  cid: ContentId.ContentId,
): ReadonlyArray<ContentId.ContentId> => store.objects.get(cid)?.validUnder ?? [];
