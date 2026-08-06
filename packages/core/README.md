# effect-triples

The platform-neutral core of Effect Triples: temporal triples, an in-memory ordered-KV
hexastore, Datalog and SPARQL query engines, snapshots, subscriptions, and Effect services.

## Install

```bash
npm install effect effect-triples
```

## In-memory store

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

SQL implementations live in `effect-triples-sql` and the backend-specific packages.

MIT © 2026 Ben Jacobson.
