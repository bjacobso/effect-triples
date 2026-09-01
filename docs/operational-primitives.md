# Operational Primitives

Triplex is the durable substrate beneath applications such as Onboarded. This specification
separates database/runtime guarantees that belong in Triplex from workflow and product concepts
that belong in an application.

## Implemented foundation

### Atomic transactions

`Triples.transact` is the only portable command boundary. SQL adapters execute it in a native SQL
transaction. KV implementations create a transaction-scoped hexastore over `KvBackend.transact`;
all index and metadata writes commit or roll back together. The in-memory backend serializes
transactions and buffers their writes. A completed KV transaction clears the shared decoded-datom
cache so reads observe its result.

`withTransaction` remains an adapter escape hatch. Because arbitrary effects cannot be rebound to
a KV transaction-scoped `Triples` service, portable code must use `transact`.

### Compare-and-retract

A transaction may declare `TripleLive` preconditions. Each condition must identify an explicit
`retract` operation in the same transaction. Retraction is the atomic comparison: exactly one
writer can retract the expected live fact. A stale writer receives `TransactionConflictError` and
all of its writes roll back.

This intentionally small primitive covers moving pointers and state machines without pretending
that a read followed by an arbitrary write is compare-and-set. Config refs and entity-validation
heads use it. An atomic "assert when no value exists" requires a separate uniqueness/index
contract and is not part of this version.

### Causal transaction envelopes

Every successful `transact` persists an `_Transaction` entity with:

- `:_tx/position`;
- `:_tx/instant`;
- `:_tx/actor` (`:_tx/user` remains readable during the pre-1.0 transition);
- `:_tx/command-id`;
- `:_tx/correlation-id`;
- `:_tx/causation-id`;
- `:_tx/config-snapshot`; and
- one `:_tx/change` JSON fact for every asserted or retracted application fact.

`Triples.transaction(txId)` reconstructs the typed envelope. The same facts remain available to
Datalog for application-specific audit queries. A command ID is an idempotency identity, not yet
an enforced uniqueness constraint.

### Ordered transaction feed

The backend allocates a monotonically increasing commit position inside the same atomic boundary
as the application facts and causal envelope. `Triples.transactions({ after, limit })` returns
envelopes in that order and exposes the last position as the next durable resume cursor. Failed
transactions publish neither facts nor a position. This avoids treating timestamps or
client-generated ULIDs as commit order under concurrency.

The feed covers successful `transact` commands; standalone low-level writes intentionally do not
create envelopes. Delivery built on repeated page reads is at least once, so consumers retain a
checkpoint and deduplicate by command or transaction identity. `ChangeEmitter` remains a
best-effort wake-up mechanism and never replaces catch-up reads.

## Next primitives

### Consumer checkpoints and command receipts

Define conventional first-class entities for consumer checkpoints, command receipts, inboxes, and
outboxes. Their movement should use compare-and-retract, while the ordered transaction feed
remains the source of catch-up truth.

### Graph constraints

Keep `TypeExpr` local and decidable. Add separately versioned config nodes for cardinality,
uniqueness, required relationships, reference target kinds, and Datalog invariants. Constraints
support observation mode, which writes first-class violations, and enforcement mode, which rejects
a command. Cross-entity policy must not be hidden inside value decoding.

### Temporal Datalog

Add an explicit transaction-time basis to Datalog so joins, rules, negation, and aggregation can
run against one historical cut. EntitySnapshot and ConfigSnapshot remain distinct; temporal
Datalog does not introduce valid/business time by implication.

### Durable materializations

Persist a materialization definition, current result head, observed dependencies, evaluation
proof, source transaction, and retry state. A materializer derives facts; Onboarded decides whether
a changed result opens a Thread or advances a Routine.

### Content-addressed blobs

Define a browser-safe `BlobStore` service that streams bytes, computes the shared SHA-256
`ContentId`, verifies reads, and leaves metadata and references in Triples. Durable adapters such
as S3 or R2 stay outside core. Garbage collection follows reachability and retention policy.

### Configuration migrations

Connect release diffs to affected-entity queries, typed transformations, checkpointed batches,
validation observations, and completion facts. Triplex owns provenance and resumability; domain
transformations remain application code.

## Boundary

Triplex should not define Threads, routine step DSLs, timers, integration catalogs, tenancy, or HR
permissions. It should provide the atomicity, concurrency, history, constraints, temporal queries,
content identity, and durable derivation mechanics those systems require.
