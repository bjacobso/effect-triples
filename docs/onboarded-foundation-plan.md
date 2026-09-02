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
- [x] Use one greenfield KV encoding and one complete SQL v1 schema.
- [x] Add a differential temporal corpus for KV, SQLite, and PostgreSQL.

### 2. Durable audit journal

- [x] Persist complete typed fact data in assertion and retraction changes.
- [x] Preserve actor, command, correlation, causation, config snapshot, commit
      position, and transaction instant.
- [x] Add parameterized/indexed command-ID lookup without claiming uniqueness.
- [x] Test a historical correction as a complete who/what/when/why timeline.

### 3. Database-per-organization isolation

- [x] Introduce a branded, validated `DatabaseId` at the manager/backend boundary.
- [x] Derive deterministic, collision-resistant PostgreSQL schema names and quote
      every identifier.
- [x] Bind every pooled PostgreSQL connection to its schema at protocol startup,
      without relying on a one-time `SET search_path` checkout.
- [x] Prove concurrent isolation for facts, Datalog, journal, config refs, and
      snapshots.
- [x] Document equivalent KV/SQLite construction in the adoption guide.

### 4. Stable pagination

- [x] Replace raw cursor JSON with a versioned, schema-decoded envelope.
- [x] Bind cursors to canonical query, ordering, temporal basis, and database
      scope fingerprints.
- [x] Use deterministic keyset order with a unique tie-breaker and pin the first
      page's exact recorded commit-position snapshot.
- [x] Add malformed, cross-query, cross-scope, concurrent-write, and backend
      parity tests.

### 5. Batched reads

- [x] Add a storage-independent `entities(ids, basis?)` primitive preserving
      request association and missing entities.
- [x] Use indexed KV reads and parameterized bounded SQL reads.
- [x] Add KV/SQLite/PostgreSQL conformance tests.
- [x] Add RequestResolver guidance.

### 6. Host-owned migrations

- [x] Export ordered, namespaced migration definitions and an explicit runner.
- [x] Provide SQL layers and adapters that can opt out of automatic DDL.
- [x] Verify idempotent fresh setup from the exported v1 migration.

### 7. Configuration foundation and adoption guide

- [x] Add a generic end-to-end release example covering entity/attribute, form,
      policy, routine/action, organization ref, operational transaction provenance,
      and later explanation from the pinned release.
- [x] Document validation's current enforcement limits accurately.
- [x] Add `docs/onboarded-foundation.md` with package/API mappings, data
      migration, database-per-organization wrapping, DSL compilation, batching,
      and journal consumption.
- [x] Update architecture and roadmap documents.

## Release gates

- [x] `pnpm check`
- [x] `pnpm pack:check`
- [x] `pnpm test:postgres:integration`
- [x] KV/SQLite/PostgreSQL temporal and pagination differential suites
- [x] Fresh migration tests
- [x] Package consumer installation checks
- [x] Generated SQL reviewed for parameterization and database isolation

Implementation is committed by slice. Nothing is pushed until all completed
slices and the release gates relevant to them are green.
