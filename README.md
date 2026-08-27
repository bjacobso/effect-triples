# @repo/config-graph

Content-addressed versioning for the configuration graph: forms, policies,
automations and the entities/attributes they all depend on, versioned as one
object rather than four unconnected version systems.

Nothing in the main app imports this yet. It is a hacking surface for the
model - `ConfigStore` is an in-memory reference implementation of the semantics
the Postgres tables would need, so the design can be exercised before any
migration is written.

| Module          | What it does                                                       |
| --------------- | ------------------------------------------------------------------ |
| `CanonicalJson` | Deterministic encoding. The substrate every hash is computed over. |
| `ContentId`     | `sha256-<hex>`, domain-separated.                                  |
| `SchemaId`      | Content-addresses an Effect Schema via its JSON Schema projection. |
| `ConfigNode`    | The merkle node: `cid`, `closureId`, `stamp`, `diff`.              |
| `SchemaCompat`  | Whether instances of one shape stay valid under another.           |
| `ConfigStore`   | Object store, revision log, snapshots, and git-style refs.         |

An instance is not bound to the schema that wrote it. `StoredObject.validUnder`
records every shape a body is known to satisfy, extended for free whenever
`SchemaCompat.subsumes` proves a new shape accepts an old one, so deploying a
projection that merely adds an optional field mints no revisions at all.
`ConfigStore.recheck` asks the deploy-gate question: would every stored body of
this kind still parse under a proposed schema?

`src/ConfigGraph.e2e.test.ts` walks a realistic account config through five
releases and is the intended entry point for reading this.

```sh
pnpm --filter @repo/config-graph test
```
