# Architecture

Triplex separates the storage-independent data model from backend implementations and now
hosts typed configuration as a modular layer over the same core.

- `@bjacobso/triplex` owns triples, typed values, Effect service contracts, the in-memory ordered-KV
  hexastore, Datalog schemas and engines, snapshots, and subscriptions. It also owns
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
- The ontology DSL compiles `Attribute` and `EntityType` declarations onto that same graph.
  Attribute keyword identity and value type live in independently addressed nodes; entity-schema
  nodes reference them and own usage-local requiredness/cardinality. TypeScript aliases are
  ergonomic handles only and do not become global attribute identity.
- `ConfigStore` records reserved `_triplex/config/*` entities and `:triplex/*` attributes through
  the `Triples` transaction boundary. Release creation and an optional ref move are atomic;
  reverse-dependency and impact-candidate discovery use Datalog, while content identity and proof
  verification remain Merkle operations.
- `ConfigRuntime` is the narrow execution bridge between the models. It resolves a config ref,
  derives a catalog from that immutable release, materializes only the current or historical
  Triple facts statically reachable by the rule, and invokes the pure evaluator. It rejects
  ambiguous multi-valued reads instead of hiding cardinality and keeps storage out of proof
  verification.
- `EntityValidation` is the schema-to-facts bridge. Runtime entity schemas are deployed as config
  nodes. Independently content-addressed `GraphConstraint` children describe required attributes,
  cardinality, uniqueness, and reference targets without expanding the value-local `TypeExpr`
  algebra. Explicit revalidation writes immutable content-addressed results and individual
  violation facts, then atomically moves per-ref heads and a projection checkpoint. The checkpoint
  records the latest non-validation transaction position observed, so convenience reads distinguish
  current, stale, and unvalidated state while Datalog can still query last-known invalid entities,
  ever-invalid entities, and historical messages. Materialized entity bodies are committed by a
  domain-separated state CID rather than copied into validation facts.
- The `Triples` transaction boundary owns portable operational guarantees. KV implementations run
  `transact` through `KvBackend.transact`, SQL implementations use their native transaction, and
  compare-and-retract preconditions turn moving facts such as config refs and validation heads
  into optimistic concurrency boundaries. Every successful `transact` persists a causal envelope
  and asserted/retracted change descriptions as ordinary `_Transaction` facts. The backend also
  allocates a monotonic commit position in that atomic boundary; `Triples.transactions` pages the
  journal from a durable resume cursor. Command IDs are atomically unique per database through a
  backend-local claim index, while the corresponding `_Transaction` remains the queryable receipt.
- Hosts may opt a transaction into graph-constraint enforcement using plain versioned rules loaded
  from its pinned `ConfigSnapshot`. After allocating the serialized commit position, the backend
  evaluates the projected post-state at every valid-time boundary before mutation. Required,
  cardinality, uniqueness, and reference-target violations that are new or worse abort facts,
  journal, command receipt, and position together; unchanged legacy violations do not prevent an
  unrelated write or repair. Enforcement discovers candidate subjects through entity-type indexes,
  batch-loads only their facts, and loads only referenced target types; it does not scan unrelated
  live facts. The shared commit-position contention point prevents concurrent Triplex writers from
  both winning an absence or uniqueness check. Direct adapter writes remain outside this guarantee,
  and authorization remains host-owned.
- The `operational` subpath owns consumer checkpoints as reserved, Datalog-queryable facts.
  Compare-and-retract prevents stale workers from overwriting a newer position. Checkpoint
  maintenance is the one unjournaled internal mutation: emitting it into the feed would cause a
  consumer to recursively consume and checkpoint its own cursor update.
- `Triples.dependencyState` is the storage-independent projection index. SQL implementations query
  covering attribute/history indexes, while KV scans the AEVT prefix. It returns the latest
  assertion-or-retraction position and earliest future valid-time edge for one fixed dependency
  set, so freshness checks and temporal wakeups do not replay the transaction journal.
- Wrapped Datalog pagination uses versioned opaque cursors whose content-addressed fingerprints bind
  the canonical query, complete projected-row keyset order, temporal basis, and database scope.
  Facts retain assertion and retraction commit positions internally, so subsequent pages read the
  exact first-page snapshot even when concurrent commits share an epoch-millisecond timestamp.
- `_triplex/` entities, `:triplex/` and `:_tx/` attributes, and Triplex-owned entity types are
  reserved for core services. Ordinary writes fail before mutation; config and validation services
  cross that boundary through a private core capability.
- `EntitySnapshot` and `ConfigSnapshot` are deliberately separate models: the former materializes
  one fact entity at a transaction/time; the latter pins an immutable release graph, revision
  stamps, dependency closures, and movable refs.
- Entity snapshots are post-commit projections. Their reads are pinned to the source transaction
  time so a later writer cannot be mislabeled as part of an earlier snapshot; projection failure
  is reported to the caller but cannot roll back the already-committed source transaction. They do
  not maintain a second transaction log: causal audit reads belong to the authoritative `Triples`
  journal APIs.
- `@bjacobso/triplex-sql` is now migrations and `SqlQueryExecutor` (the SQL implementation of the
  `QueryExecutor` SPI) shared by SQLite and PostgreSQL. Datalog SQL projections retain hidden
  value-tag columns until result decoding, and
  scalar-family joins and typed keyset ordering compare values consistently with the KV executor.
  A shared KV/SQLite/PostgreSQL conformance corpus is the regression boundary for this contract.
- Backend packages construct the storage adapters and runtime layers for their platforms.
- `@bjacobso/triplex-testkit` is the public home for reusable backend conformance helpers.
- `test/integration` owns tests that intentionally compose multiple publishable packages.
- `test/stress` owns opt-in performance and scale tests.

The core package may not depend on a backend package. SQL and backend packages may depend on core,
and concrete SQL backends may depend on `@bjacobso/triplex-sql`. This one-way graph keeps the core
usable in browsers and edge runtimes.

The core package must not use `node:crypto` or another Node-only hashing API. Canonical encoding
and SHA-256 live in `content`, so both entity snapshots and typed configuration retain identical
content-addressing semantics in Node.js, browsers, and edge runtimes.
