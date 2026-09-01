# Architecture

Effect Triples separates the storage-independent data model from backend implementations and now
hosts typed configuration as a modular layer over the same core.

- `effect-triples` owns triples, typed values, Effect service contracts, the in-memory ordered-KV
  hexastore, Datalog and SPARQL schemas and engines, snapshots, and subscriptions. It also owns
  the merged **`Triples`** service (writes + triple reads + Datalog reads in one tag) and both of
  its implementations: `TriplesLive` (over `StorageAdapter` + the `QueryExecutor` SPI) and
  `KvTriplesLive` (a single hexastore handle over any `KvBackend`). The Datalog-over-SQL wiring
  now lives in core (`TriplesLive` + the `QueryExecutor` SPI), not in the SQL package.
- Core's `content` module owns deterministic canonical encoding, domain-separated browser-safe
  SHA-256, and the shared `ContentId` format. Entity snapshots and configuration use distinct
  domains over this one foundation.
- Core's `config` subpath owns `TypeExpr`, config nodes, catalogs, evaluation proofs, reactors,
  immutable `ConfigSnapshot` release roots, the pure `InMemoryConfigStore` reference semantics,
  and the Effect-native `ConfigStore` persisted through `Triples`.
- `EntitySnapshot` and `ConfigSnapshot` are deliberately separate models: the former materializes
  one fact entity at a transaction/time; the latter pins an immutable release graph, revision
  stamps, dependency closures, and movable refs.
- `effect-triples-sql` is now migrations, `SqlQueryExecutor` (the SQL implementation of the
  `QueryExecutor` SPI), and the `Sparql` layer — the query execution shared by SQLite and
  PostgreSQL.
- Backend packages construct the storage adapters and runtime layers for their platforms.
- `effect-triples-testkit` is the public home for reusable backend conformance helpers.
- `test/integration` owns tests that intentionally compose multiple publishable packages.
- `test/stress` owns opt-in performance and scale tests.

The core package may not depend on a backend package. SQL and backend packages may depend on core,
and concrete SQL backends may depend on `effect-triples-sql`. This one-way graph keeps the core
usable in browsers and edge runtimes.
