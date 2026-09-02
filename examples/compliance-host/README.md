# Triplex compliance host demo

This standalone example shows the application boundary around Triplex's portable derivation
primitives. A generic site-safety policy requires training evidence for a worker assigned to a
site. The host application:

- publishes a content-addressed configuration release;
- compiles a host entity schema into content-addressed graph constraints and enforces them in the
  same transaction as operational writes;
- writes operational placement and evidence facts with causal metadata;
- consumes the ordered transaction feed from a durable `ConsumerCheckpoint`;
- materializes a Datalog derivation and reconciles it into durable requirement occurrences;
- previews a submission through a read-only hypothetical overlay;
- schedules the materializer at `nextTemporalBoundary`; and
- reopens work when the evidence expires, without another source transaction.

Run it from the repository root:

```sh
pnpm example:compliance-host
```

The demo is self-verifying and also runs during `pnpm test`.

## What belongs where

Triplex owns facts, temporal Datalog, configuration identity, candidate provenance, immutable
materialization runs, reconciliation diffs, atomically unique command receipts, durable consumer
checkpoints, and temporal-boundary discovery. The example host owns timer delivery, requirement
occurrence lifecycle, command naming, and the meaning of "satisfied" versus "open".

The in-memory scheduler makes that boundary easy to see. A production host should replace it with
an at-least-once job system. The feed cursor is already a reserved Triplex fact and advances only
after reconciliation succeeds. Reconciliation remains idempotent: it inspects durable requirement
facts before opening, closing, or revising work.
