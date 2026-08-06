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

Writes and queries live together on a single service, `Triples`. The core package
includes a zero-dependency in-memory backend, so a working store is one layer —
`KvTriples.layer`:

```ts
import { Effect } from "effect";
import { KvTriples, Triples, string } from "effect-triples";

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
`match` for triple patterns, `query` for Datalog — are methods on it. `Sparql`,
`SnapshotService`, `SubscriptionManager`, and `DatabaseManager` remain separate,
optional services with their own consumers. There is no fluent `Database` facade —
you compose the services you need and provide one storage `Layer`.

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

Assert one fact, a batch, or an atomic transaction, and read facts back by entity or
by pattern:

```ts
import { number, ref, string, Triples } from "effect-triples";

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

  // an atomic transaction with metadata (records :_tx/user and :_tx/instant)
  const tx = yield* triples.transact(
    [
      { op: "assert", entityId: "person:carol", attribute: ":person/name", value: string("Carol") },
      { op: "retract", id: triple.id },
    ],
    { user: "importer" },
  );

  // reads
  const alice = yield* triples.entity("person:alice"); // all facts for the entity
  const names = yield* triples.match({ attribute: ":person/name" }); // by pattern
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

Each `transact` also writes a synthetic transaction entity carrying `:_tx/instant`
(the commit time as a `datetime`) and `:_tx/user`, so provenance can be queried like
any other fact — see the transaction-metadata Datalog example below.

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

| Package                       | Convenience layer                         | Runtime                                        |
| ----------------------------- | ----------------------------------------- | ---------------------------------------------- |
| `effect-triples`              | `KvTriples.layer` (in-memory)             | Node.js 22+, browsers, edge runtimes           |
| `effect-triples-sql`          | shared SQL query/executor + SPARQL layers | SQL-capable runtimes                           |
| `effect-triples-sqlite`       | `SqliteTriples.layer({ filename })`       | Node.js 22+                                    |
| `effect-triples-postgres`     | `PgTriples.layer(config)`                 | Node.js 22+                                    |
| `effect-triples-cloudflare`   | Cloudflare Durable Object SQLite adapter  | Cloudflare Workers                             |
| `effect-triples-foundationdb` | `FdbTriples.layer(config)`                | Node.js 22+ with FoundationDB client libraries |
| `effect-triples-testkit`      | `makeTriplesConformanceSuite` + fixtures  | Node.js 22+                                    |

A durable stack is a single convenience layer. For SQLite:

```ts
import { SqliteTriples } from "effect-triples-sqlite";

const SqliteLive = SqliteTriples.layer({ filename: "app.db" });
// or SqliteTriples.layerMemory for an in-memory database
```

The rest of your program is unchanged — it still depends only on the `Triples` service
tag. For manual wiring, provide `TriplesLive` over a `StorageAdapter`, a
`QueryExecutor` (`SqlQueryExecutorLive`), and a `TripleStoreRuntime`.

## Entrypoints

Everything is re-exported from the package root, so `import { … } from "effect-triples"`
always works — this is where the service tags (`Triples`, `Sparql`, `SnapshotService`,
and `SubscriptionManager`), the value helpers, and the layers live.

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
not the runtime service tags — import `Triples`, `Sparql`, and `SnapshotService`
from the root. The HTTP/RPC surface is exposed under `./DatalogApi`,
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
