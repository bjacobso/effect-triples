---
"@bjacobso/triplex": patch
"@bjacobso/triplex-postgres": patch
---

Add indexed, snapshot-stable entity transaction timelines with complete causal journal records.

Add PostgreSQL layers that compose Triplex with an ambient host-owned Effect SQL client or a validated database-scoped pool, preserving one fiber-local transaction and savepoint boundary without exposing the internal storage adapter.

Stabilize public triple and transaction identities as runtime-decodable branded values, with transaction IDs remaining valid entity IDs.
