# Onboarded foundation implementation plan

This plan tracks the work required for Triplex to replace Onboarded's vendored
fact store without weakening isolation, temporal, pagination, or audit
semantics. Onboarded remains a read-only reference; all implementation lives in
Triplex and stays application-independent.

## Baseline

- [x] Read Triplex architecture, roadmap, and operational-primitives documents.
- [x] Inspect the Triples service, storage SPI, KV hexastore, SQLite and
      PostgreSQL adapters, Datalog executors, transaction journal, snapshots,
      subscriptions, and configuration runtime.
- [x] Inspect Onboarded's fact-store, entity DSL, query, batching, transaction,
      and vendored storage implementations.
- [x] Establish a green baseline: `pnpm check`, `pnpm pack:check`, and the
      PostgreSQL integration suite pass at commit `9c7dd80`.

## Implementation slices

### 1. Authoritative bitemporal model

- [x] Add explicit `TemporalBasis`, recorded assertion/retraction times, and
      `validFrom`/`validTo` to public facts and storage rows.
- [x] Default `validFrom` to the transaction instant and `validTo` to open-ended.
- [x] Apply the same visibility rule to direct reads and all Datalog clauses.
- [x] Implement KV encoding/index compatibility and SQL schema upgrade/backfill.
- [x] Add a differential temporal corpus for KV, SQLite, and PostgreSQL.

### 2. Durable audit journal

- [x] Persist complete typed fact data in assertion and retraction changes.
- [x] Preserve actor, command, correlation, causation, config snapshot, commit
      position, and transaction instant.
- [x] Add parameterized/indexed command-ID lookup without claiming uniqueness.
- [x] Test a historical correction as a complete who/what/when/why timeline.

### 3. Database-per-organization isolation

- [ ] Introduce a branded, validated `DatabaseId` at the manager/backend boundary.
- [ ] Derive deterministic, collision-resistant PostgreSQL schema names and quote
      every identifier.
- [ ] Bind every pooled PostgreSQL query to its schema without relying on
      `search_path` session state.
- [ ] Prove concurrent isolation for facts, Datalog, journal, config refs, and
      snapshots, and document equivalent KV/SQLite construction.

### 4. Stable pagination

- [ ] Replace raw cursor JSON with a versioned, schema-decoded envelope.
- [ ] Bind cursors to canonical query, ordering, temporal basis, and database
      scope fingerprints.
- [ ] Use deterministic keyset order with a unique tie-breaker and pin the first
      page's recorded-time snapshot.
- [ ] Add malformed, cross-query, cross-scope, concurrent-write, and backend
      parity tests.

### 5. Batched reads

- [x] Add a storage-independent `entities(ids, basis?)` primitive preserving
      request association and missing entities.
- [x] Use indexed KV reads and parameterized bounded SQL reads.
- [x] Add KV/SQLite/PostgreSQL conformance tests.
- [ ] Add RequestResolver guidance.

### 6. Host-owned migrations

- [ ] Export ordered, namespaced migration definitions and an explicit runner.
- [ ] Provide SQL layers that can opt out of automatic DDL.
- [ ] Verify idempotent fresh setup and upgrade/backfill from the `9c7dd80`
      schema without losing transaction or retraction history.

### 7. Configuration foundation and adoption guide

- [ ] Add a generic end-to-end release example covering entity/attribute, form,
      policy, routine/action, organization ref, operational transaction provenance,
      and later explanation from the pinned release.
- [ ] Document validation's current enforcement limits accurately.
- [ ] Add `docs/onboarded-foundation.md` with package/API mappings, data
      migration, database-per-organization wrapping, DSL compilation, batching,
      and journal consumption.
- [ ] Update architecture and roadmap documents.

## Release gates

- [ ] `pnpm check`
- [ ] `pnpm pack:check`
- [ ] `pnpm test:postgres:integration`
- [ ] KV/SQLite/PostgreSQL temporal and pagination differential suites
- [ ] Fresh and upgrade migration tests
- [ ] Package consumer installation checks
- [ ] Generated SQL reviewed for parameterization and database isolation

Implementation is committed by slice. Nothing is pushed until all completed
slices and the release gates relevant to them are green.
