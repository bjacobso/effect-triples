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
 * **A snapshot is itself a `ConfigNode`.** Its children are the objects and its
 * attrs carry their stamps, so `ConfigNode.diff` works on two snapshots
 * unchanged, and the merkle shape means comparing two large snapshots costs
 * work proportional to what actually differs.
 */

import { Data, Effect } from "effect";

import * as CanonicalJson from "./CanonicalJson";
import * as ConfigNode from "./ConfigNode";
import * as ContentId from "./ContentId";

export interface StoredObject {
  readonly cid: ContentId.ContentId;
  readonly kind: string;
  /** Exactly the value that was hashed. */
  readonly body: CanonicalJson.CanonicalValue;
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

export interface Snapshot {
  readonly id: string;
  readonly seq: number;
  readonly label: string;
  readonly rootCid: ContentId.ContentId;
  /** Retained so `ConfigNode.diff` can walk two snapshots directly. */
  readonly root: ConfigNode.ConfigNode;
  readonly revisionIds: ReadonlyArray<string>;
  readonly parentId: string | null;
}

export interface ConfigStore {
  readonly objects: ReadonlyMap<ContentId.ContentId, StoredObject>;
  /** Append-only log of every projection shape ever used. */
  readonly schemas: ReadonlyMap<
    ContentId.ContentId,
    CanonicalJson.CanonicalValue
  >;
  readonly revisions: ReadonlyArray<Revision>;
  readonly snapshots: ReadonlyArray<Snapshot>;
  /** Ref name (`live`, `test`) to snapshot id. */
  readonly refs: ReadonlyMap<string, string>;
  readonly seq: number;
}

export class DanglingRefError extends Data.TaggedError("DanglingRefError")<{
  readonly from: ObjectKey;
  readonly to: ObjectKey;
  readonly message: string;
}> {}

export class DuplicateObjectError extends Data.TaggedError(
  "DuplicateObjectError"
)<{
  readonly object: ObjectKey;
  readonly message: string;
}> {}

export class UnknownSnapshotError extends Data.TaggedError(
  "UnknownSnapshotError"
)<{
  readonly id: string;
  readonly message: string;
}> {}

const SNAPSHOT_KIND = "snapshot";

const slotOf = (object: ObjectKey) => `${object.kind} ${object.key}`;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const empty = (): ConfigStore => ({
  objects: new Map(),
  schemas: new Map(),
  revisions: [],
  snapshots: [],
  refs: new Map(),
  seq: 0,
});

/** Newest-first revision chain for one logical object. */
export const historyOf = (
  store: ConfigStore,
  object: ObjectKey
): ReadonlyArray<Revision> =>
  store.revisions
    .filter((rev) => rev.kind === object.kind && rev.key === object.key)
    .sort((a, b) => b.seq - a.seq);

export const tipOf = (
  store: ConfigStore,
  object: ObjectKey
): Revision | undefined => historyOf(store, object)[0];

export const revisionById = (
  store: ConfigStore,
  id: string
): Revision | undefined => store.revisions.find((rev) => rev.id === id);

export const snapshotById = (
  store: ConfigStore,
  id: string
): Snapshot | undefined => store.snapshots.find((snap) => snap.id === id);

export const resolveRef = (
  store: ConfigStore,
  name: string
): Snapshot | undefined => {
  const id = store.refs.get(name);
  return id === undefined ? undefined : snapshotById(store, id);
};

/**
 * Point a ref at a snapshot. This is the entire deploy primitive: promoting a
 * snapshot to live and rolling back to the previous one are the same operation
 * in opposite directions, and neither copies or rewrites any configuration.
 */
export const setRef = (
  store: ConfigStore,
  name: string,
  snapshotId: string
): Effect.Effect<ConfigStore, UnknownSnapshotError> =>
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
  bySlot: ReadonlyMap<string, ConfigNode.ConfigNode>
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

    return [...found.values()].sort(
      (a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key)
    );
  });

export interface CommitResult {
  readonly store: ConfigStore;
  readonly snapshot: Snapshot;
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
  store: ConfigStore,
  input: {
    readonly label: string;
    readonly objects: ReadonlyArray<ConfigNode.ConfigNode>;
  }
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
          message: `Snapshot "${input.label}" contains ${object.kind} "${object.key}" twice`,
        });
      }
      bySlot.set(slot, object);
    }

    const ordered = [...input.objects].sort(
      (a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key)
    );

    const objects = new Map(store.objects);
    const schemas = new Map(store.schemas);
    const revisions = [...store.revisions];
    const created: Revision[] = [];
    let seq = store.seq;

    const stamps: Array<{ kind: string; key: string; stamp: string }> = [];
    const revisionIds: string[] = [];

    for (const object of ordered) {
      // Content-address every node in the subtree. Identical subtrees across
      // objects, modes or accounts collapse onto one entry.
      for (const { node } of ConfigNode.walk(object)) {
        if (!objects.has(node.cid)) {
          objects.set(node.cid, {
            cid: node.cid,
            kind: node.kind,
            body: ConfigNode.body(node),
          });
        }
        if (node.schema && !schemas.has(node.schema.cid)) {
          schemas.set(node.schema.cid, node.schema.jsonSchema);
        }
      }

      const deps = yield* transitiveDeps(object, bySlot);
      const closureCid = yield* ConfigNode.closureId(
        object,
        deps.map((dep) => ({ ...dep, cid: bySlot.get(slotOf(dep))!.cid }))
      );
      const stamp = yield* ConfigNode.stamp(object);
      const schemaCids = ConfigNode.schemaCids(object);

      // `stamp` already folds in `cid` and the subtree's schemas, so it and the
      // closure together decide whether this revision still describes reality.
      const tip = tipOf({ ...store, revisions }, object);
      const unchanged =
        tip !== undefined &&
        tip.stamp === stamp &&
        tip.closureCid === closureCid;

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

      stamps.push({ kind: object.kind, key: object.key, stamp });
    }

    // The snapshot is a node like any other: children give it a cheap merkle
    // diff, attrs pin the stamps so a projector change is visible even when no
    // data moved.
    const root = yield* ConfigNode.make({
      kind: SNAPSHOT_KIND,
      key: input.label,
      attrs: { stamps },
      children: ordered.map((node) => ({ rel: node.kind, node })),
    });

    // The root is an object too; a snapshot whose bytes are not in the store
    // would be a cid nobody can resolve.
    objects.set(root.cid, {
      cid: root.cid,
      kind: root.kind,
      body: ConfigNode.body(root),
    });

    seq += 1;
    const parent = store.snapshots[store.snapshots.length - 1];
    const snapshot: Snapshot = {
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
  store: ConfigStore,
  from: Snapshot,
  to: Snapshot
): ReadonlyArray<ObjectChange> => {
  const revisionsOf = (snapshot: Snapshot) =>
    new Map(
      snapshot.revisionIds
        .map((id) => revisionById(store, id))
        .filter((rev): rev is Revision => rev !== undefined)
        .map((rev) => [slotOf(rev), rev] as const)
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
