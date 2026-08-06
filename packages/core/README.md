# effect-triples

The platform-neutral core of Effect Triples: temporal triples, an in-memory ordered-KV
hexastore, Datalog and SPARQL query engines, snapshots, subscriptions, and Effect services.

## Install

```bash
npm install effect effect-triples
```

## In-memory store

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

  return yield* triples.query({
    find: ["?name"],
    where: [["?person", ":person/name", "?name"]],
  });
});

Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer)));
```

SQL implementations live in `effect-triples-sql` and the backend-specific packages.

MIT © 2026 Ben Jacobson.
