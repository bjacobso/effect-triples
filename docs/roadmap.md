# Database Package Suggestions & Roadmap

This document outlines strategic enhancements to make `@bjacobso/triplex` a world-class, open-source triple store and Datalog engine.

The operational foundation and its ordering constraints are specified in
[`operational-primitives.md`](operational-primitives.md). Atomic KV transactions,
compare-and-retract conditions, causal transaction envelopes, and per-transaction change journals
are implemented, including a backend-issued commit cursor and resumable transaction pages. The
next reliability milestone is conventional consumer checkpoints and command receipts, followed by
graph constraints and portable derivation candidates with checkpointed reconciliation.

## Immediate correctness gate: backend parity

- The first differential Datalog corpus now runs identical typed projections, scalar joins,
  predicates, negation, booleans, and ref joins against KV and SQLite. Grow this corpus with every
  query-engine bug, then run it against PostgreSQL before marking that adapter stable.
- Cover every value type, value-to-value joins, recursive rules, aggregation, unbound variables,
  links, pagination, and hostile schema-valid inputs.
- SQL projection now carries hidden storage tags through execution, so strings such as `"007"`,
  numeric-looking entity IDs and refs, datetimes, booleans, and JSON are decoded without guessing.
- Keep PostgreSQL, FoundationDB, and Cloudflare experimental until each backend passes the shared
  conformance and differential suites in CI.

## 1. Structured Data Retrieval (Pull API)

**Goal:** Enable fetching nested, hierarchical data in a single query.

- Implement a Datomic-style `pull` API: `pull(entityId, [":name", {":friends": [":name"]}])`.
- Reduce the need for manual result-shaping in application code.
- Optimize by batching underlying SQL queries for nested attributes.

## 2. Schema-Aware Constraints & Enforcement

**Goal:** Move from a "bag of facts" to a reliable, structured database.

- **Uniqueness:** Enforce unique attributes (e.g., `:user/email`).
- **Required Attributes:** Validate that entities of a specific type have mandatory facts.
- **Reference Integrity:** Ensure `:ref` values point to existing entities.
- **Cardinality:** Distinguish between single-valued and multi-valued attributes.
- Keep these graph constraints separate from value-local `TypeExpr` definitions.
- Support both queryable observation findings and opt-in transaction enforcement.

## 3. Reactive "Live" Queries (Watch API)

**Goal:** Power real-time, reactive user interfaces.

- Implement triple-level dependency tracking for Datalog queries.
- Provide a `watchQuery` function that emits new results when relevant facts change.
- Enable incremental result updates to minimize re-computation.
- Build reliable invalidation on the ordered transaction feed; `ChangeEmitter` remains a
  best-effort wake-up mechanism.

## 4. Application-Level Multi-tenancy

**Goal:** Native, safe isolation for SaaS applications.

- Define tenancy and authorization above the raw Triples service until there is a complete threat
  model and a backend-portable query/write policy contract.
- Do not add an ambient `tenantId` column that silently changes query semantics.

## 5. Bitemporality (Valid Time)

**Goal:** Distinguish between when a fact was recorded and when it became true.

- Implemented across KV, SQLite, and PostgreSQL with a shared recorded/valid basis for direct reads
  and Datalog.
- Differential tests cover historical corrections, future-effective facts, retractions, joins, and
  negation.
- Next: surface temporal wakeup boundaries from derivations so expiry-driven projections reopen
  without relying on a daily full scan.

## 6. Integrated Full-Text Search (FTS)

**Goal:** Seamlessly combine graph traversal with text search.

- Expose a `(fts ?entity "search term")` predicate within Datalog.
- Support relevance scoring and highlighting in query results.
- Leverage underlying SQL engine FTS capabilities (SQLite FTS5, Postgres GIN/GiST).

## 7. Performance & Query Optimization

**Goal:** Handle millions of triples with sub-millisecond latency.

- **Cost-Based Optimizer:** Reorder Datalog clauses based on attribute cardinality.
- **JSON Indexing:** Optimize `value_json` lookups for complex data types.
- **Recursive Rule Performance:** Optimize CTE generation for deep graph traversals.

## 8. Client-Side Sync & Offline-First

**Goal:** Enable seamless data replication to edge devices and browsers.

- Develop a sync protocol for replicating filtered triple subsets to a client.
- Provide a lightweight browser-side Hexastore for local querying.
- Implement conflict resolution strategies for offline writes.

## 9. Developer Experience (DX) & Tooling

**Goal:** Make the database "inspectable" and easy to use.

- **Database Studio:** A web-based UI for exploring entities, history, and snapshots.
- **Type-Safe Query Builder:** Autocomplete for attributes and variables in TypeScript.
- **OpenTelemetry Integration:** Built-in tracing for query execution and performance bottlenecks.
