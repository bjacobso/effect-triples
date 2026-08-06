# Effect Triples demo

This demo uses the self-contained in-memory backend to write linked entities, read
raw triples, filter with Datalog, and traverse a relationship with a Datalog join.

From the repository root:

```sh
pnpm example:demo
```

The same program can use a durable backend by replacing `KvTriples.layer` with one
of the backend layers documented in the root README.
