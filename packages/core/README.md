# @bjacobso/triplex

An Effect-native fact database with Datalog and typed, content-addressed configuration.

The platform-neutral core includes temporal triples, an in-memory ordered-KV hexastore,
Datalog and SPARQL query engines, subscriptions, entity snapshots, configuration releases,
and Effect services.

## Install

```bash
npm install effect @bjacobso/triplex
```

## In-memory store

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

  return yield* triples.query({
    find: ["?name"],
    where: [["?person", ":person/name", "?name"]],
  });
});

Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer)));
```

SQL implementations live in `@bjacobso/triplex-sql` and the backend-specific packages.

## Typed configuration

```ts
import { Triples } from "@bjacobso/triplex";
import { ConfigStore, Evaluate, TypeExpr } from "@bjacobso/triplex/config";
```

`ConfigStore.layer` stores typed configuration graphs, immutable `ConfigSnapshot`
releases, revisions, dependency closures, and movable refs through the `Triples`
transaction boundary. `InMemoryConfigStore` is the immutable semantic reference.
`Evaluate` creates and verifies content-addressed decision proofs.

`EntitySnapshot` is a temporal materialization of one triple entity. `ConfigSnapshot`
is a complete immutable configuration release; they have separate APIs and identities.

## Content addressing

`@bjacobso/triplex/content` exports deterministic canonical encoding and browser-safe,
domain-separated SHA-256 `ContentId` values. IDs use the format
`sha256-<64 lowercase hex characters>`.

The pre-1.0 entity-snapshot hash changed from `fnv1a:<8 hex characters>`. SQL migrations
remove legacy snapshot/blob rows; applications that need those historical derived
materializations must rebuild them from temporal triples.

MIT © 2026 Ben Jacobson.
