# Operational Primitives

Triplex is the durable substrate beneath applications such as Onboarded. This specification
separates database/runtime guarantees that belong in Triplex from workflow and product concepts
that belong in an application.

## Implemented foundation

### Atomic transactions

`Triples.transact` is the authoritative portable command boundary. `assert`, `assertBatch`,
`retract`, and `retractByPattern` delegate to it, so every supported write receives one commit
position and causal envelope. SQL adapters execute it in a native SQL transaction. KV
implementations create a transaction-scoped hexastore over `KvBackend.transact`; all index and
metadata writes commit or roll back together. The in-memory backend serializes transactions and
buffers their writes. A completed KV transaction clears the shared decoded-datom cache so reads
observe its result.

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

The feed covers every successful public write. Delivery built on repeated page reads is at least
once, so consumers retain a checkpoint and deduplicate by command or transaction identity.
`ChangeEmitter` remains a best-effort wake-up mechanism and never replaces catch-up reads.

### Bitemporal query basis

Facts carry separate recorded and valid intervals. Direct matching, entity reads, batched reads,
and Datalog accept the same `{ recordedAt?, validAt? }` basis, so every clause in a join,
negation, or rule sees one coherent cut. Historical corrections append new facts; they do not
rewrite the recorded history.

### Portable derivations and pure reconciliation

`@bjacobso/triplex/derivation` provides a content-addressed `Definition` that pins a complete
structural Datalog query, optional result `TypeExpr`, canonical identity projection, discovered
attribute dependencies, and configuration snapshot. Evaluation returns `Candidate` values with:

- a stable logical identity derived from the definition name and declared result key;
- a revision covering the exact definition, config pin, result, and explanation;
- the pinned bitemporal basis;
- merged source triple IDs and assertion transaction IDs/positions from every positive graph path;
  and
- the earliest future `validTo` among supporting facts, when one is known.

The complete `Evaluation` also exposes a conservative `nextTemporalBoundary` across the current
recorded view of every dependency attribute. It includes both future `validFrom` and `validTo`
edges, including facts inside negated clauses that currently suppress every candidate. This lets a
host wake exactly when evidence may expire or become effective without a daily full scan. The
portable implementation scans the ordered journal and can produce harmless extra wakeups for
unrelated entities that share an attribute, but it does not omit a recorded boundary.

`reconcile` is a pure diff that classifies candidates as `added`, `removed`, `changed`, or
`unchanged`. A host can translate that diff into durable requirement occurrences, tasks, or other
governed work without coupling those concepts to Triplex. Conflicting outputs for the same
declared identity fail with a typed error rather than being selected arbitrarily.

`Derivation.Materialization` persists candidate revisions and complete evaluation runs as
immutable Triples system entities. Each run atomically binds its definition, config snapshot,
bitemporal basis, candidate set, and latest dependency-relevant transaction position. There is no
mutable first-writer checkpoint race: the current run for a definition is selected by source
position and then materialization commit position. A newly deployed definition has its own stream,
while reconciliation can still compare its stable logical candidate identities with the preceding
run for the same name.

`current` returns explicit `current`, `stale`, or `unmaterialized` state and retains the last
durable candidates when stale. Relevant transaction positions are derived from the definition's
discovered attributes; materializer and unrelated transactions do not create false lag. Persisted
candidate bodies are schema-decoded and content-verified. Immutable run membership can be queried
with ordinary Datalog for audit and composition. Versioned run identities content-bind and expose
the evaluation's `nextTemporalBoundary`, including runs with zero candidates. Triplex does not own
timer delivery: a host scheduler wakes the materializer at that instant and persists the next run.

`Derivation.Overlay.evaluateOverlay` applies temporary assertions and visible-triple retractions
at a pinned basis in a fresh private in-memory KV store. It seeds only the definition's discovered
fixed attributes and delegates to the same structural Datalog evaluator, then translates source
facts back to durable IDs or deterministic hypothetical content commitments. The source Triples
store and transaction journal are never mutated. This supports collect-versus-reuse and proposed
relationship planning with the same candidate identity and explanation shape as committed data.

Assertions whose `validFrom` is omitted begin at the overlay's `validAt`. Retractions must identify
facts visible at that basis, and duplicate or irrelevant patch operations fail explicitly. Dynamic
attribute queries and transaction-binding clauses are rejected because a bounded copy could not
preserve their semantics honestly.

The initial provenance contract supports patterns, predicates, and negation. Recursive rules,
disjunction, aggregation, and pagination are rejected until their exact provenance semantics are
implemented.

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

### Indexed projection checkpoints

Derivation freshness currently discovers its dependency-relevant source position by scanning the
ordered transaction journal. Add conventional consumer receipts/checkpoints and an indexed latest
relevant position so long-running materializers can resume without a full scan. Triplex should not
turn an added candidate into a Task or a removed candidate into a cancellation; applications own
durable occurrences, assignment, evidence disposition, conversations, and retry policy.

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
