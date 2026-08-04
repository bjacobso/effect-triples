# Database Package Suggestions & Roadmap

This document outlines strategic enhancements to make `@open-ontology/database` a world-class, open-source triple store and Datalog engine.

## 1. Structured Data Retrieval (Pull API)
**Goal:** Enable fetching nested, hierarchical data in a single query.
*   Implement a Datomic-style `pull` API: `pull(entityId, [":name", {":friends": [":name"]}])`.
*   Reduce the need for manual result-shaping in application code.
*   Optimize by batching underlying SQL queries for nested attributes.

## 2. Schema-Aware Constraints & Enforcement
**Goal:** Move from a "bag of facts" to a reliable, structured database.
*   **Uniqueness:** Enforce unique attributes (e.g., `:user/email`).
*   **Required Attributes:** Validate that entities of a specific type have mandatory facts.
*   **Reference Integrity:** Ensure `:ref` values point to existing entities.
*   **Cardinality:** Distinguish between single-valued and multi-valued attributes.

## 3. Reactive "Live" Queries (Watch API)
**Goal:** Power real-time, reactive user interfaces.
*   Implement triple-level dependency tracking for Datalog queries.
*   Provide a `watchQuery` function that emits new results when relevant facts change.
*   Enable incremental result updates to minimize re-computation.

## 4. Built-in Multi-tenancy
**Goal:** Native, safe isolation for SaaS applications.
*   Add a `tenantId` column to the `triples` table.
*   Automatically inject tenant scoping into all Datalog and TripleStore operations.
*   Ensure zero data-leakage across tenants by default.

## 5. Bitemporality (Valid Time)
**Goal:** Distinguish between when a fact was recorded and when it became true.
*   Add `valid_from` and `valid_to` columns to the `triples` table.
*   Enable "What was the state of the world on Jan 1st, as we knew it on Feb 1st?" style queries.
*   Critical for auditing, legal compliance, and correcting historical data.

## 6. Integrated Full-Text Search (FTS)
**Goal:** Seamlessly combine graph traversal with text search.
*   Expose a `(fts ?entity "search term")` predicate within Datalog.
*   Support relevance scoring and highlighting in query results.
*   Leverage underlying SQL engine FTS capabilities (SQLite FTS5, Postgres GIN/GiST).

## 7. Performance & Query Optimization
**Goal:** Handle millions of triples with sub-millisecond latency.
*   **Cost-Based Optimizer:** Reorder Datalog clauses based on attribute cardinality.
*   **JSON Indexing:** Optimize `value_json` lookups for complex data types.
*   **Recursive Rule Performance:** Optimize CTE generation for deep graph traversals.

## 8. Client-Side Sync & Offline-First
**Goal:** Enable seamless data replication to edge devices and browsers.
*   Develop a sync protocol for replicating filtered triple subsets to a client.
*   Provide a lightweight browser-side Hexastore for local querying.
*   Implement conflict resolution strategies for offline writes.

## 9. Developer Experience (DX) & Tooling
**Goal:** Make the database "inspectable" and easy to use.
*   **Database Studio:** A web-based UI for exploring entities, history, and snapshots.
*   **Type-Safe Query Builder:** Autocomplete for attributes and variables in TypeScript.
*   **OpenTelemetry Integration:** Built-in tracing for query execution and performance bottlenecks.
