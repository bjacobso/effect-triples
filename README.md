# Effect Triples

A standalone, Effect-native triple store with temporal facts, Datalog and SPARQL queries,
reactive subscriptions, snapshots, and pluggable storage backends.

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

  return yield* datalog.query({
    find: ["?name"],
    where: [["?person", ":person/name", "?name"]],
  });
});

Effect.runPromise(program.pipe(Effect.provide(StorageLive)));
```

## Packages

| Package                       | Purpose                                                                        | Runtime                                        |
| ----------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `effect-triples`              | Core store, in-memory hexastore, Datalog, SPARQL, snapshots, and subscriptions | Node.js, browsers, edge runtimes               |
| `effect-triples-sql`          | Shared SQL storage and query layers                                            | SQL-capable runtimes                           |
| `effect-triples-sqlite`       | SQLite adapter using `@effect/sql-sqlite-node`                                 | Node.js 22+                                    |
| `effect-triples-postgres`     | PostgreSQL adapter using `@effect/sql-pg`                                      | Node.js 22+                                    |
| `effect-triples-cloudflare`   | Cloudflare Durable Object SQLite adapter                                       | Cloudflare Workers                             |
| `effect-triples-foundationdb` | Ordered-KV backend for FoundationDB                                            | Node.js 22+ with FoundationDB client libraries |
| `effect-triples-testkit`      | Shared backend test helpers                                                    | Node.js 22+                                    |

All packages are ESM-only and currently versioned as pre-1.0 software. APIs may change between
minor releases.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

The regular test suite is self-contained. PostgreSQL and FoundationDB integration tests are
available as opt-in commands because they require Docker or native client libraries. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT © 2026 Ben Jacobson.
