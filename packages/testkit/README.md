# @bjacobso/triplex-testkit

Reusable backend fixture and capability helpers for testing Triplex adapters.

```bash
npm install --save-dev effect @bjacobso/triplex-testkit
```

`triplesConformanceCases` and `makeTriplesConformanceSuite` define the behavioral contract used by
the in-memory KV, SQLite, and opt-in PostgreSQL suites. The corpus covers atomic writes, typed
values, temporal reads, Datalog semantics, stable pagination, the transaction journal, command
receipts, checkpoints, derivations, and graph constraints. New backends should pass it before being
described as supported.

The package is not yet published to npm.

MIT © 2026 Ben Jacobson.
