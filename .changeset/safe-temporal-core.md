---
"@bjacobso/triplex": patch
"@bjacobso/triplex-sql": patch
"@bjacobso/triplex-sqlite": patch
"@bjacobso/triplex-postgres": patch
"@bjacobso/triplex-cloudflare": patch
"@bjacobso/triplex-foundationdb": patch
"@bjacobso/triplex-testkit": patch
---

Harden configuration identity, validation, subscriptions, and backend safety; add bitemporal reads, durable journals, batch loading, scope-bound snapshot-stable Datalog pagination, and content-addressed derivation candidates with provenance, durable materialization checkpoints and temporal wakeups, read-only hypothetical overlays, and a standalone compliance-host example and adoption guide.

Establish the greenfield storage and API baseline: one v1 SQL migration, one recorded-time retraction field, one bitemporal query basis, actor-only journal provenance, and raw Datalog as the sole structural query language.

Remove redundant pre-release surfaces: the unused demo database schemas, transaction-time-only aliases, the non-portable transaction escape hatch, duplicate snapshot composition, synthetic snapshot triple compatibility, and advisory blob reference counts.

Remove unused extension hooks and transport-specific errors, and collapse redundant `Triple`, `Snapshot`, and `types/Pattern` subpaths into the primary package export.

Keep entity snapshots focused on content-addressed materialization by removing their duplicate raw-SQL transaction log and unused response schemas; transaction history remains available through the durable `Triples` journal.
