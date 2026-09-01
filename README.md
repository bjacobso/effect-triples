<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/triplex-logo-dark.svg" />
    <img src="assets/triplex-logo.svg" alt="Triplex logo" width="640" />
  </picture>
</p>

# Triplex

An Effect-native fact database with Datalog and typed, content-addressed configuration.

Triplex combines temporal triples, pluggable storage, Datalog queries,
reactive subscriptions, entity materializations, and immutable configuration releases.

> Pre-1.0 software: APIs may change between minor releases.

Everything is modeled as `(entity, attribute, value)` facts. Writes are append-only,
so history is retained and any past state is queryable. The fact store answers raw
Datalog queries, and the storage layer is a swappable Effect `Layer`:
an in-memory hexastore for tests and the browser, or SQLite, PostgreSQL, Cloudflare
Durable Objects, and FoundationDB for durable deployments.

## Installation

```sh
pnpm add @bjacobso/triplex effect
```

`@bjacobso/triplex` is ESM-only and targets Node.js 22+ (its core also runs in modern
browsers and edge runtimes). It is developed and tested against
`effect@4.0.0-rc.112`; upgrading Effect independently may require a matching Triplex
release. Storage backends ship as separate packages (see
[Storage backends](#storage-backends)).

## Quick start

Writes and queries live together on a single service, `Triples`. The core package
includes a zero-dependency in-memory backend, so a working store is one layer —
`KvTriples.layer`:

```ts
import { Effect } from "effect";
import { KvTriples, Triples, string } from "@bjacobso/triplex";

const program = Effect.gen(function* () {
  const triples = yield* Triples;

  yield* triples.assert({
    entityId: "person:alice",
    attribute: ":person/name",
    value: string("Alice"),
  });

  // triple-pattern read
  const facts = yield* triples.match({ attribute: ":person/name" });

  // Datalog read
  const { results } = yield* triples.query({
    find: ["?name"],
    where: [["?person", ":person/name", "?name"]],
  });

  return results; // => [{ "?name": "Alice" }]
});

Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer)));
```

For a runnable version that writes linked entities and reads them through both
triple matching and Datalog, run `pnpm example:demo` or see
[`examples/demo`](examples/demo).

`Triples` is the store's one service: `assert`/`transact` and both read paths —
`match` for triple patterns, `query` for Datalog — are methods on it.
`SnapshotService`, `SubscriptionManager`, and `DatabaseManager` remain separate,
optional services with their own consumers. There is no fluent `Database` facade —
you compose the services you need and provide one storage `Layer`.

## Typed configuration

Configuration is a first-class module of the primary package, exposed through a
tree-shakeable subpath rather than flattening its symbols into the root:

```ts
import { Triples } from "@bjacobso/triplex";
import {
  ConfigRuntime,
  ConfigStore,
  EntityValidation,
  Evaluate,
  TypeExpr,
} from "@bjacobso/triplex/config";
```

`TypeExpr` describes runtime-defined types as content-addressed data. Config nodes form
immutable Merkle graphs; commits produce `ConfigSnapshot` release roots containing
revisions, schema stamps, and dependency closures. Git-style refs such as `live` and
`test` can move between releases without copying configuration.

`ConfigStore.layer` persists those objects through any `Triples` implementation and
commits a release plus an optional ref move in one Triples transaction. It preserves
deduplication, structural sharing, schema compatibility, and `validUnder` history while
using Datalog for reverse-dependency and deploy-impact candidates. The immutable
`InMemoryConfigStore` remains available as the reference implementation. `Evaluate`
produces reproducible decision proofs, and `Evaluate.verify` detects altered decisions
or observations without replacing Merkle verification with database queries.

`ConfigRuntime.evaluate` is the storage-to-proof bridge: it resolves a release ref, builds
the rule catalog from that exact `ConfigSnapshot`, reads only the temporal Triple facts
the rule can observe, and returns the pinned evaluation:

```ts
const decision =
  yield *
  ConfigRuntime.evaluate({
    ref: "live",
    rule: "may-deploy",
    subject: "employee:alice",
    clock: { now: Date.now(), granularity: "day" },
  });

ConfigRuntime.verify(decision); // []
```

The decision ID binds the selected release root, subject, and nested evaluation; changing
either the configuration pin or the proof breaks `ConfigRuntime.verify`. Passing `asOf`
evaluates the same deployed rule against historical facts. Cardinality is
explicit: a rule read with multiple live Triple values fails instead of selecting one
arbitrarily, and non-scalar JSON facts are rejected at the bridge.

### Validating facts against deployed types

Entity types can be configuration too. Define a closed runtime shape using the exact
Triple attribute names, commit it with the rest of the release, and explicitly revalidate
after moving a config ref or changing facts:

```ts
const employeeSchema =
  yield *
  EntityValidation.define(
    "Employee",
    TypeExpr.struct({
      ":employee/name": TypeExpr.required(TypeExpr.text),
      ":employee/age": TypeExpr.required(TypeExpr.integer),
    }),
  );

yield *
  configStore.commit({
    label: "employee schema v2",
    objects: [employeeSchema],
    ref: "live",
  });

const validation = yield * EntityValidation.EntityValidation;
yield * validation.revalidate({ ref: "live" });

const invalidNow = yield * validation.currentInvalid("live");
const invalidAtLeastOnce = yield * validation.everInvalid();
const messages = yield * validation.violations({ subject: "employee:alice" });
```

Every result is bound to the exact `ConfigSnapshot`, schema `ContentId`, subject, and
materialized entity state. Results and individual violations are immutable,
content-addressed entities under reserved Triplex attributes. Revalidation atomically
moves a `(ref, entity type, subject)` head; fixing an entity removes it from the current
invalid query without erasing that it was invalid before. `currentInvalidQuery`,
`everInvalidQuery`, and `violationsQuery` return ordinary Datalog queries for composing
validation state with the rest of an application's graph.

Revalidation is explicit in this release: call it after relevant fact writes and after
moving or committing the selected config ref. These are observations, not write guards: after
a ref move, old results do not match the new snapshot; after a fact-only change, the previous
observation remains current until revalidation moves its head. Applications that require
synchronous write validation should place the write and follow-up workflow behind their own
command boundary.

The browser example at [`examples/config-explorer`](examples/config-explorer) walks
through typed nodes, releases, refs, impact, evaluation, and proof verification.

## Triples and values

A fact is asserted from a `TripleInput`:

```ts
interface TripleInput {
  entityId: string;
  attribute: string; // ":namespace/name" convention
  value: TripleValue;
  entityType?: string; // optional class tag, e.g. "Person"
  createdBy?: string;
}
```

Values are tagged, not raw JavaScript. Construct them with the helpers exported from
the package root — this keeps the stored type explicit and makes references
first-class:

| Helper                              | Value type | Example                                         |
| ----------------------------------- | ---------- | ----------------------------------------------- |
| `string(v)`                         | `string`   | `string("Alice")`                               |
| `number(v)`                         | `number`   | `number(30)`                                    |
| `boolean(v)`                        | `boolean`  | `boolean(true)`                                 |
| `datetime(v)`                       | `datetime` | `datetime(Date.now())` / `datetime(new Date())` |
| `ref(entityId)`                     | `ref`      | `ref("person:bob")`                             |
| `json(v)`                           | `json`     | `json({ tags: ["a", "b"] })`                    |
| `blob(hash, mimeType, size, name?)` | `blob`     | `blob("sha256:…", "image/png", 2048)`           |

`ref` values link entities together and are what graph-style queries traverse. A
`datetime` is stored as epoch milliseconds.

Datalog constants use scalar equality unless their type is explicit. A bare string such as
`"person:bob"` matches stored `string`, `ref`, or `blob` values with that scalar; a bare number
matches both `number` and `datetime` values with that scalar. This also applies when a variable is
bound from one clause and reused in another. Use a typed constant such as `ref("person:bob")` when
the query must match only a stored `ref`. Query bindings and projected results remain unwrapped
JavaScript scalars.

Assert one fact, a batch, or an atomic transaction, and read facts back by entity or
by pattern:

```ts
import { number, ref, string, Triples } from "@bjacobso/triplex";

Effect.gen(function* () {
  const triples = yield* Triples;

  // one fact
  const triple = yield* triples.assert({
    entityId: "person:alice",
    attribute: ":person/name",
    value: string("Alice"),
    entityType: "Person",
  });

  // many facts at once
  yield* triples.assertBatch([
    { entityId: "person:alice", attribute: ":person/age", value: number(30) },
    { entityId: "person:bob", attribute: ":person/name", value: string("Bob") },
    { entityId: "person:alice", attribute: ":person/knows", value: ref("person:bob") },
  ]);

  // an atomic transaction with a queryable causal envelope
  const tx = yield* triples.transact(
    [
      { op: "assert", entityId: "person:carol", attribute: ":person/name", value: string("Carol") },
      { op: "retract", id: triple.id },
    ],
    {
      actor: "service:importer",
      commandId: "import:2026-09-01:carol",
      correlationId: "import:2026-09-01",
      configSnapshot: "sha256:…",
    },
  );

  // reads
  const alice = yield* triples.entity("person:alice"); // all facts for the entity
  const names = yield* triples.match({ attribute: ":person/name" }); // by pattern
  return { tx: tx.txId, position: tx.position, alice, names };
});
```

A query pattern is `{ entityId?, attribute?, entityType?, value? }`; omitted fields
match anything. Writes never mutate in place — `retract` and `retractByPattern` stamp a
fact as retracted rather than deleting it, which is what makes the store temporal.

## Temporal facts and time travel

Because retraction is a stamp, not a delete, every fact carries `createdAt` and an
optional `retractedAt`, and the full timeline of an entity is always recoverable. Two
methods expose this directly:

```ts
Effect.gen(function* () {
  const triples = yield* Triples;

  // point-in-time: facts that were live at a given instant (epoch millis)
  const asOfLastWeek = yield* triples.matchAsOf(
    { attribute: ":person/name" },
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  );

  // full assertion/retraction history for one entity
  const timeline = yield* triples.history("person:alice");

  return { asOfLastWeek, timeline };
});
```

Each `transact` writes a synthetic `_Transaction` entity containing a backend-issued
`:_tx/position`, `:_tx/instant`, actor, command, correlation, causation, governing config snapshot,
and JSON change facts. Read one typed envelope with `triples.transaction(txId)`, query the reserved
attributes through Datalog, or catch up in commit order:

```ts
const page = yield * triples.transactions({ after: checkpoint, limit: 100 });
for (const transaction of page.transactions) {
  yield * handleAtLeastOnce(transaction);
}
const nextCheckpoint = page.next ?? checkpoint;
```

The cursor is committed atomically with the journal, so a failed transaction cannot appear in the
feed. The feed covers `transact`; standalone low-level writes do not create envelopes.
Best-effort `ChangeEmitter` notifications are kept separate and should only wake a consumer that
then catches up from its durable checkpoint.

### Conditional transactions

Moving facts can use compare-and-retract semantics. A `TripleLive` precondition must name a triple
also retracted by the transaction. If another writer retracts it first, the entire transaction
rolls back with `TransactionConflictError`:

```ts
const current = (yield *
  triples.match({
    entityId: "task:42",
    attribute: ":task/status",
  }))[0]!;

yield *
  triples.transact(
    [
      { op: "retract", id: current.id },
      {
        op: "assert",
        entityId: "task:42",
        attribute: ":task/status",
        value: string("claimed"),
      },
    ],
    {
      actor: "agent:worker-7",
      commandId: "claim:task:42",
      preconditions: [{ _tag: "TripleLive", id: current.id }],
    },
  );
```

This is the primitive used by config-ref and entity-validation-head movement. It is suitable for
task claims, leases, idempotent commands, and optimistic form updates. `Triples.transact` is atomic
on both SQL and KV backends; the in-memory KV backend also serializes concurrent transactions.
Standalone `assert`, `assertBatch`, and `retract` remain low-level writes and do not create the full
causal envelope, so operational commands should use `transact`.

## Datalog queries

Datalog is the primary query language. Call `triples.query(query)`; it resolves to
`{ results }`, where `results` is an array of binding objects whose keys keep the `?`
prefix. `find` lists the variables (or constants) to project; `where` is a list of
clauses. Sharing a variable across two patterns joins them.

### Patterns and joins

```ts
// implicit join on ?person across two patterns
triples.query({
  find: ["?name", "?age"],
  where: [
    ["?person", ":person/name", "?name"],
    ["?person", ":person/age", "?age"],
  ],
});
// results => [{ "?name": "Alice", "?age": 30 }, ...]
```

A pattern is `[entity, attribute, value]`. Any position may be a variable (`"?x"`) or a
constant. To match a `ref` value, use a typed constant:

```ts
where: [["?movie", ":movie/director", { type: "ref", value: "person:nolan" }]];
```

### Predicate filters

Inline comparison clauses filter bound variables. Operators: `>`, `>=`, `<`, `<=`,
`=`, `!=`.

```ts
triples.query({
  find: ["?name", "?age"],
  where: [
    ["?person", ":person/name", "?name"],
    ["?person", ":person/age", "?age"],
    [">=", "?age", 30],
  ],
});
```

### Negation and disjunction

```ts
// people who are NOT inactive
where: [
  ["?person", ":person/name", "?name"],
  ["not", ["?person", ":person/status", "inactive"]],
];

// Alice OR Bob
where: [
  [
    "or",
    [
      ["?person", ":person/name", "Alice"],
      ["?person", ":person/name", "Bob"],
    ],
  ],
];
```

### Aggregation, ordering, and limits

`aggregate` clauses are `[op, sourceVar, targetVar]` with `count`, `sum`, `avg`, `min`,
`max`; grouping is implicit over the non-aggregated `find` variables. `having`,
`orderBy`, `limit`, and `offset` are also supported.

```ts
triples.query({
  find: ["?count"],
  where: [["?person", ":person/age", "?age"]],
  aggregate: [["count", "?person", "?count"]],
});
// results => [{ "?count": 3 }]
```

### Transaction provenance

Bind the transaction id as an optional fourth pattern element, then join it against the
transaction metadata entity written by `transact`:

```ts
where: [
  ["?e", ":person/name", "?name", "?tx"],
  ["?tx", ":_tx/user", "?user"],
];
```

### Recursive rules

Recursive rules (e.g. ancestor/descendant closures) run through `triples.query` like any
other query — provide `rules` alongside `find`/`where`. Each rule is
`{ name, body, maxDepth? }`, and same-named rules union together. A rule-application
clause `["ancestor", "person:alice", "?ancestor"]` invokes a rule. SQL backends compile
rules to recursive CTEs; KV backends evaluate them with semi-naive evaluation.

```ts
triples.query({
  find: ["?ancestor"],
  where: [["ancestor", "person:alice", "?ancestor"]],
  rules: [
    { name: "ancestor", body: [["?x", ":parent", "?y"]] },
    {
      name: "ancestor",
      body: [
        ["?x", ":parent", "?z"],
        ["ancestor", "?z", "?y"],
      ],
    },
  ],
});
```

The compile-only entrypoint is still available for tooling: `compileWithRules(query)`
returns the SQL and params without executing.

## Entity snapshots and subscriptions

`SnapshotService` materializes the current or historical state of one triple entity as
an `EntitySnapshot`: a canonicalized, content-hashed record useful for change detection,
sync, and audit:

```ts
import { SnapshotService } from "@bjacobso/triplex";

Effect.gen(function* () {
  const snapshots = yield* SnapshotService;
  const now = yield* snapshots.current("person:alice");
  const earlier = yield* snapshots.asOf("person:alice", someEpochMillis);
  const changes = yield* snapshots.diff("person:alice", fromTxId, toTxId);
  return { now, earlier, changes };
});
```

`SubscriptionManager` powers reactive/live queries. Register a Datalog query under an
id; as facts change, `checkAffected` reports which subscriptions are invalidated. There
is no `store.subscribe(...)` method — this dependency-tracking model, together with
`TopicFilteredSyncHub` for websocket-style push, is the building block for live queries
and client sync.

An `EntitySnapshot` is not a configuration release. `ConfigSnapshot`, exported from
`@bjacobso/triplex/config`, is an immutable root for a complete typed configuration
release. The names and APIs remain separate so a point-in-time entity materialization
cannot be confused with a deployable configuration graph.

```ts
import { SubscriptionManager } from "@bjacobso/triplex";

Effect.gen(function* () {
  const subs = yield* SubscriptionManager;
  yield* subs.register("active-people", {
    find: ["?name"],
    where: [
      ["?p", ":person/name", "?name"],
      ["?p", ":person/status", "active"],
    ],
  });
  const affected = yield* subs.checkAffected(changes); // from a write's change set
  return affected;
});
```

## Storage backends

The core package runs entirely in memory. Durable backends are separate packages that
provide the same `Triples` service over a real store, each with a one-line convenience
layer.

| Package                          | Convenience layer                        | Runtime                                        |
| -------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `@bjacobso/triplex`              | `KvTriples.layer` (in-memory)            | Node.js 22+, browsers, edge runtimes           |
| `@bjacobso/triplex-sql`          | shared SQL query executor                | SQL-capable runtimes                           |
| `@bjacobso/triplex-sqlite`       | `SqliteTriples.layer({ filename })`      | Node.js 22+                                    |
| `@bjacobso/triplex-postgres`     | `PgTriples.layer(config)`                | Node.js 22+                                    |
| `@bjacobso/triplex-cloudflare`   | Cloudflare Durable Object SQLite adapter | Cloudflare Workers                             |
| `@bjacobso/triplex-foundationdb` | `FdbTriples.layer(config)`               | Node.js 22+ with FoundationDB client libraries |
| `@bjacobso/triplex-testkit`      | `makeTriplesConformanceSuite` + fixtures | Node.js 22+                                    |

A durable stack is a single convenience layer. For SQLite:

```ts
import { SqliteTriples } from "@bjacobso/triplex-sqlite";

const SqliteLive = SqliteTriples.layer({ filename: "app.db" });
// or SqliteTriples.layerMemory for an in-memory database
```

The rest of your program is unchanged — it still depends only on the `Triples` service
tag. For manual wiring, provide `TriplesLive` over a `StorageAdapter`, a
`QueryExecutor` (`SqlQueryExecutorLive`), and a `TripleStoreRuntime`.

## Entrypoints

The package root exports the triples, query, entity-snapshot, and subscription APIs.
Typed configuration stays under `@bjacobso/triplex/config`, and shared content-addressing
primitives stay under `@bjacobso/triplex/content`, keeping both entrypoints tree-shakeable.

The core package also exposes tree-shakeable ESM subpaths for the schemas, types, and
transport surface:

```ts
import { TripleInput, TransactOp } from "@bjacobso/triplex/Triple";
import { DatalogQuery } from "@bjacobso/triplex/Datalog";
import { SubscriptionManager } from "@bjacobso/triplex/subscriptions";
import { Pattern } from "@bjacobso/triplex/types/Pattern";
import { ConfigStore, TypeExpr } from "@bjacobso/triplex/config";
import { ContentId } from "@bjacobso/triplex/content";
```

Note that `./Datalog` and `./Snapshot` contain query/response **schemas**, not the
runtime service tags — import `Triples` and `SnapshotService` from the root. The
HTTP/RPC surface is exposed under `./DatalogApi`,
`./DatalogRpc`, `./Database`, `./DatabaseApi`, `./DatabaseRpc`, `./SnapshotApi`,
`./TripleApi`, and `./TripleRpc`.

## Content IDs and pre-1.0 migration

Triplex uses one browser-safe content-addressing foundation: deterministic canonical
encoding followed by domain-separated SHA-256. A `ContentId` is formatted as
`sha256-<64 lowercase hex characters>`, with distinct domains for entity snapshots,
config nodes, closures, stamps, types, evaluations, release-pinned decisions, and observations.

This replaces the earlier `fnv1a:<8 hex characters>` entity-snapshot hash. SQL
migrations 20 and 21 remove legacy entity-snapshot pointers and their derived blobs;
applications that need those historical materializations must rebuild them from the
temporal triples. Triplex intentionally does not retain a dual-format shim before 1.0.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

The regular test suite is self-contained. PostgreSQL and FoundationDB integration tests
are opt-in because they require Docker or native client libraries. See
[CONTRIBUTING.md](./CONTRIBUTING.md), and [ARCHITECTURE.md](./ARCHITECTURE.md) for the
package dependency graph.

## Roadmap

Planned work is tracked in [docs/roadmap.md](./docs/roadmap.md), including a structured
Pull API, schema-aware constraints, reactive "live" queries, built-in multi-tenancy,
bitemporality (valid time), integrated full-text search, query optimization, and
client-side sync / offline-first support.

## License

MIT © 2026 Ben Jacobson.
