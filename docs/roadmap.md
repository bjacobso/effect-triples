# Database Package Suggestions & Roadmap

This document outlines strategic enhancements to make `@bjacobso/triplex` a world-class, open-source triple store and Datalog engine.

The operational foundation and its ordering constraints are specified in
[`operational-primitives.md`](operational-primitives.md). Atomic KV transactions,
compare-and-retract conditions, causal transaction envelopes, and per-transaction change journals
are implemented, including a backend-issued commit cursor and resumable transaction pages. The
portable derivation candidates and their immutable, freshness-aware materialization runs are also
implemented, including durable temporal wakeups for future-effective and expiring evidence. The
wrapped Datalog API now has typed, scope-bound, commit-position-stable keyset cursors. The next
reliability milestone is indexed dependency schedules and projection freshness, followed by graph
constraints. Command receipts are atomically unique and durable consumer checkpoints are available
through the `operational` subpath.

## Immediate correctness gate: backend parity

- The conformance corpus now runs identical typed projections, scalar joins, predicates, negation,
  booleans, ref joins, bitemporal reads, and snapshot-stable pagination against KV, SQLite, and
  PostgreSQL. Grow it with every query-engine bug.
- Cover every value type, value-to-value joins, recursive rules, aggregation, unbound variables,
  links, pagination, and hostile schema-valid inputs.
- SQL projection now carries hidden storage tags through execution, so strings such as `"007"`,
  numeric-looking entity IDs and refs, datetimes, booleans, and JSON are decoded without guessing.
- Keep PostgreSQL, FoundationDB, and Cloudflare experimental until each backend passes the shared
  conformance and differential suites in CI.

## 1. Schema-Aware Constraints & Enforcement

**Goal:** Move from a "bag of facts" to a reliable, structured database.

- **Uniqueness:** Enforce unique attributes (e.g., `:user/email`).
- **Required Attributes:** Validate that entities of a specific type have mandatory facts.
- **Reference Integrity:** Ensure `:ref` values point to existing entities.
- **Cardinality:** Distinguish between single-valued and multi-valued attributes.
- Keep these graph constraints separate from value-local `TypeExpr` definitions.
- Support both queryable observation findings and opt-in transaction enforcement.

## 2. Reactive "Live" Queries (Watch API)

**Goal:** Power real-time, reactive user interfaces.

- Implement triple-level dependency tracking for Datalog queries.
- Provide a `watchQuery` function that emits new results when relevant facts change.
- Enable incremental result updates to minimize re-computation.
- Build reliable invalidation on the ordered transaction feed; `ChangeEmitter` remains a
  best-effort wake-up mechanism.

## 3. Application-Level Multi-tenancy

**Goal:** Native, safe isolation for SaaS applications.

- Define tenancy and authorization above the raw Triples service until there is a complete threat
  model and a backend-portable query/write policy contract.
- Do not add an ambient `tenantId` column that silently changes query semantics.

## Delivered foundation: Bitemporality (Valid Time)

**Goal:** Distinguish between when a fact was recorded and when it became true.

- Implemented across KV, SQLite, and PostgreSQL with a shared recorded/valid basis for direct reads
  and Datalog.
- Differential tests cover historical corrections, future-effective facts, retractions, joins, and
  negation.
- Structural derivations expose the earliest recorded future `validFrom` or `validTo` across their
  dependency attributes. Immutable materialization runs persist and content-bind that schedule,
  including zero-candidate runs suppressed by negated evidence. A host scheduler can therefore
  reopen expiry-driven projections without a daily full scan. Next: replace the conservative
  journal scan with indexed dependency schedules and durable consumer checkpoints.

## 4. Integrated Full-Text Search (FTS)

**Goal:** Seamlessly combine graph traversal with text search.

- Expose a `(fts ?entity "search term")` predicate within Datalog.
- Support relevance scoring and highlighting in query results.
- Leverage underlying SQL engine FTS capabilities (SQLite FTS5, Postgres GIN/GiST).

## 5. Performance & Query Optimization

**Goal:** Handle millions of triples with sub-millisecond latency.

- **Cost-Based Optimizer:** Reorder Datalog clauses based on attribute cardinality.
- **JSON Indexing:** Optimize `value_json` lookups for complex data types.
- **Recursive Rule Performance:** Optimize CTE generation for deep graph traversals.

## 6. Client-Side Sync & Offline-First

**Goal:** Enable seamless data replication to edge devices and browsers.

- Develop a sync protocol for replicating filtered triple subsets to a client.
- Provide a lightweight browser-side Hexastore for local querying.
- Implement conflict resolution strategies for offline writes.

## 7. Developer Experience (DX) & Tooling

**Goal:** Make the database "inspectable" and easy to use.

- **Database Studio:** A web-based UI for exploring entities, history, and snapshots.
- **OpenTelemetry Integration:** Built-in tracing for query execution and performance bottlenecks.
