# Effect Triples

A standalone, Effect-native triple store with temporal facts, Datalog and SPARQL
queries, reactive subscriptions, content-addressed snapshots, and pluggable storage
backends.

> Pre-1.0 software: APIs may change between minor releases.

Everything is modeled as `(entity, attribute, value)` facts. Writes are append-only,
so history is retained and any past state is queryable. The same fact store answers
both Datalog and SPARQL queries, and the storage layer is a swappable Effect `Layer`:
an in-memory hexastore for tests and the browser, or SQLite, PostgreSQL, Cloudflare
Durable Objects, and FoundationDB for durable deployments.

## Installation

```sh
pnpm add effect-triples effect
```

`effect-triples` is ESM-only and targets Node.js 22+ (it also runs in modern browsers
and edge runtimes). It is developed and tested against `effect@3.19.13`; upgrading
Effect independently may require a matching `effect-triples` release. Storage backends
ship as separate packages (see [Storage backends](#storage-backends)).

## Quick start

The core package includes a zero-dependency in-memory backend, so a working store is
four layers. `KvDatalogLive` provides the `Datalog` service and `KvTripleStoreLive`
provides `TripleStore`; both run on the in-memory `KvBackend` and share a
`TripleStoreRuntime` (clock and id generator).

```ts
import { Effect, Layer } from "effect";
import {
  Datalog,
  InMemoryKvBackendLive,
  KvDatalogLive,
  KvTripleStoreLive,
  TripleStore,
  TripleStoreRuntimeLayer,
  string,
} from "effect-triples";

const StorageLive = KvDatalogLive.pipe(
  Layer.provideMerge(KvTripleStoreLive),
  Layer.provide(TripleStoreRuntimeLayer),
  Layer.provide(InMemoryKvBackendLive),
);

const program = Effect.gen(function* () {
  const store = yield* TripleStore;
  const datalog = yield* Datalog;

  yield* store.assert({
    entityId: "person:alice",
    attribute: ":person/name",
    value: string("Alice"),
  });

  const result = yield* datalog.query({
    find: ["?name"],
    where: [["?person", ":person/name", "?name"]],
  });

  return result.results; // => [{ "?name": "Alice" }]
});

Effect.runPromise(program.pipe(Effect.provide(StorageLive)));
```

Access the store and query engines through their service tags (`TripleStore`,
`Datalog`, `Sparql`, `SnapshotService`, `SubscriptionManager`). There is no fluent
`Database` facade — you compose the services you need and provide one storage `Layer`.

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

| Helper                                | Value type | Example                                  |
| ------------------------------------- | ---------- | ---------------------------------------- |
| `string(v)`                           | `string`   | `string("Alice")`                        |
| `number(v)`                           | `number`   | `number(30)`                             |
| `boolean(v)`                          | `boolean`  | `boolean(true)`                          |
| `datetime(v)`                         | `datetime` | `datetime(Date.now())` / `datetime(new Date())` |
| `ref(entityId)`                       | `ref`      | `ref("person:bob")`                      |
| `json(v)`                             | `json`     | `json({ tags: ["a", "b"] })`             |
| `blob(hash, mimeType, size, name?)`   | `blob`     | `blob("sha256:…", "image/png", 2048)`    |

`ref` values link entities together and are what graph-style queries traverse. A
`datetime` is stored as epoch milliseconds.

Assert one fact, a batch, or an atomic transaction, and read facts back by entity or
by pattern:

```ts
import { number, ref, string } from "effect-triples";

Effect.gen(function* () {
  const store = yield* TripleStore;

  // one fact
  const triple = yield* store.assert({
    entityId: "person:alice",
    attribute: ":person/name",
    value: string("Alice"),
    entityType: "Person",
  });

  // many facts at once
  yield* store.assertBatch([
    { entityId: "person:alice", attribute: ":person/age", value: number(30) },
    { entityId: "person:bob", attribute: ":person/name", value: string("Bob") },
    { entityId: "person:alice", attribute: ":person/knows", value: ref("person:bob") },
  ]);

  // an atomic transaction with metadata (records :_tx/user and :_tx/instant)
  const tx = yield* store.transact(
    [
      { op: "assert", entityId: "person:carol", attribute: ":person/name", value: string("Carol") },
      { op: "retract", id: triple.id },
    ],
    { user: "importer" },
  );

  // reads
  const alice = yield* store.getEntity("person:alice"); // all facts for the entity
  const names = yield* store.query({ attribute: ":person/name" }); // by pattern
  return { tx: tx.txId, alice, names };
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
  const store = yield* TripleStore;

  // point-in-time: facts that were live at a given instant (epoch millis)
  const asOfLastWeek = yield* store.queryAsOf(
    { attribute: ":person/name" },
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  );

  // full assertion/retraction history for one entity
  const timeline = yield* store.history("person:alice");

  return { asOfLastWeek, timeline };
});
```

Each `transact` also writes a synthetic transaction entity carrying `:_tx/instant`
(the commit time as a `datetime`) and `:_tx/user`, so provenance can be queried like
any other fact — see the transaction-metadata Datalog example below.

## Datalog queries

Datalog is the primary query language. Call `datalog.query(query)`; it resolves to
`{ results }`, where `results` is an array of binding objects whose keys keep the `?`
prefix. `find` lists the variables (or constants) to project; `where` is a list of
clauses. Sharing a variable across two patterns joins them.

### Patterns and joins

```ts
// implicit join on ?person across two patterns
datalog.query({
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
datalog.query({
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
  ["or", [
    ["?person", ":person/name", "Alice"],
    ["?person", ":person/name", "Bob"],
  ]],
];
```

### Aggregation, ordering, and limits

`aggregate` clauses are `[op, sourceVar, targetVar]` with `count`, `sum`, `avg`, `min`,
`max`; grouping is implicit over the non-aggregated `find` variables. `having`,
`orderBy`, `limit`, and `offset` are also supported.

```ts
datalog.query({
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

Recursive rules (e.g. ancestor/descendant closures) are a compile-only API rather than
part of the `Datalog` service: `compileWithRules(query)` returns SQL (recursive CTEs)
that you run through a SQL client. Provide `rules` alongside `find`/`where`, where each
rule is `{ name, body, maxDepth? }` and same-named rules union together.

```ts
import { compileWithRules } from "effect-triples";

const { sql, params } = compileWithRules({
  find: ["?ancestor"],
  where: [["ancestor", "person:alice", "?ancestor"]],
  rules: [
    { name: "ancestor", body: [["?x", ":parent", "?y"]] },
    { name: "ancestor", body: [["?x", ":parent", "?z"], ["ancestor", "?z", "?y"]] },
  ],
});
// run `sql` with `params` via a SQL-backed client (see effect-triples-sql)
```

## SPARQL queries

SPARQL is available through the `Sparql` service (provided by the SQL layer,
`SparqlLive` in `effect-triples-sql`). Queries are a JSON DSL rather than a query
string. Variables use `?` and attributes use `:`, matching Datalog.

```ts
import { Sparql } from "effect-triples";

Effect.gen(function* () {
  const sparql = yield* Sparql;

  const result = yield* sparql.query({
    form: "select",
    select: { variables: ["?name", "?email"] },
    where: [
      ["?person", ":person/name", "?name"],
      ["?person", ":person/age", "?age"],
      { filter: { op: ">=", left: "?age", right: 30 } },
      { optional: [["?person", ":person/email", "?email"]] },
    ],
  });

  // result is a tagged union; for SELECT the rows are:
  if (result.results.type === "select") {
    return result.results.results;
  }
});
```

`where` supports `optional`, `union`, `minus`, `filter` (comparisons plus built-ins
like `contains`, `regex`, `strstarts`), `bind`, `values`, property paths, and
subselects. Convenience helpers `sparql.select(query)` return the binding rows
directly, and `sparql.ask(query)` returns a `boolean`.

## Snapshots and subscriptions

`SnapshotService` materializes the current or historical state of an entity as a single
canonicalized, content-hashed record — useful for change detection, sync, and audit:

```ts
import { SnapshotService } from "effect-triples";

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

```ts
import { SubscriptionManager } from "effect-triples";

Effect.gen(function* () {
  const subs = yield* SubscriptionManager;
  yield* subs.register("active-people", {
    find: ["?name"],
    where: [["?p", ":person/name", "?name"], ["?p", ":person/status", "active"]],
  });
  const affected = yield* subs.checkAffected(changes); // from a write's change set
  return affected;
});
```

## Storage backends

The core package runs entirely in memory. Durable backends are separate packages that
provide the same `TripleStore`/`Datalog`/`Sparql` services over a real store.

| Package                       | Purpose                                                                        | Runtime                                        |
| ----------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `effect-triples`              | Core store, in-memory hexastore, Datalog, SPARQL, snapshots, and subscriptions | Node.js 22+, browsers, edge runtimes           |
| `effect-triples-sql`          | Shared SQL storage and query layers (`DatalogLive`, `SparqlLive`, executor)    | SQL-capable runtimes                           |
| `effect-triples-sqlite`       | SQLite adapter using `@effect/sql-sqlite-node`                                 | Node.js 22+                                    |
| `effect-triples-postgres`     | PostgreSQL adapter using `@effect/sql-pg`                                      | Node.js 22+                                    |
| `effect-triples-cloudflare`   | Cloudflare Durable Object SQLite adapter                                       | Cloudflare Workers                             |
| `effect-triples-foundationdb` | Ordered-KV backend for FoundationDB                                            | Node.js 22+ with FoundationDB client libraries |
| `effect-triples-testkit`      | Shared backend test helpers                                                    | Node.js 22+                                    |

A SQL-backed stack composes the SQL layers over an adapter and a client. For SQLite:

```ts
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  TripleStoreLive,
  TripleStoreRuntimeLayer,
  RuntimeServicesLive,
} from "effect-triples";
import { DatalogLive, SqlQueryExecutorLive } from "effect-triples-sql";
import { SqliteAdapterLive } from "effect-triples-sqlite";

const SqliteLive = DatalogLive.pipe(
  Layer.provideMerge(SqlQueryExecutorLive),
  Layer.provideMerge(TripleStoreLive),
  Layer.provideMerge(SqliteAdapterLive),
  Layer.provideMerge(SqliteClient.layer({ filename: "app.db" })),
  Layer.provide(TripleStoreRuntimeLayer),
  Layer.provideMerge(RuntimeServicesLive),
);
```

The rest of your program is unchanged — it still depends only on the `TripleStore` and
`Datalog` service tags.

## Entrypoints

Everything is re-exported from the package root, so `import { … } from "effect-triples"`
always works — this is where the service tags (`TripleStore`, `Datalog`, `Sparql`,
`SnapshotService`, `SubscriptionManager`), the value helpers, and the layers live.

The core package also exposes tree-shakeable ESM subpaths for the schemas, types, and
transport surface:

```ts
import { TripleInput, TransactOp } from "effect-triples/Triple";
import { DatalogQuery } from "effect-triples/Datalog";
import { SparqlQuery } from "effect-triples/Sparql";
import { SubscriptionManager } from "effect-triples/subscriptions";
import { Pattern } from "effect-triples/types/Pattern";
```

Note that `./Datalog`, `./Sparql`, and `./Snapshot` contain query/response **schemas**,
not the runtime service tags — import the `Datalog`, `Sparql`, and `SnapshotService`
tags from the root. The HTTP/RPC surface is exposed under `./DatalogApi`,
`./DatalogRpc`, `./Database`, `./DatabaseApi`, `./DatabaseRpc`, `./SnapshotApi`,
`./TripleApi`, and `./TripleRpc`.

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
