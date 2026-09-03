<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/triplex-logo-dark.svg" />
    <img src="assets/triplex-logo.svg" alt="Triplex logo" width="640" />
  </picture>
</p>

# Triplex

An Effect-native fact database with Datalog and typed, content-addressed configuration.

Triplex combines temporal triples, pluggable storage, Datalog queries,
reactive subscriptions, entity materializations, and immutable configuration releases.

> Pre-1.0 software: APIs may change between minor releases.

Everything is modeled as `(entity, attribute, value)` facts. Writes are append-only,
so history is retained and any past state is queryable. The fact store answers raw
Datalog queries, and the storage layer is a swappable Effect `Layer`:
an in-memory hexastore for tests and the browser, or SQLite, PostgreSQL, Cloudflare
Durable Objects, and FoundationDB for durable deployments.

## Installation

```sh
pnpm add @bjacobso/triplex effect
```

`@bjacobso/triplex` is ESM-only and targets Node.js 22+ (its core also runs in modern
browsers and edge runtimes). It is developed and tested against
`effect@4.0.0-rc.112`; upgrading Effect independently may require a matching Triplex
release. Storage backends ship as separate packages (see
[Storage backends](#storage-backends)).

## Quick start

Writes and queries live together on a single service, `Triples`. The core package
includes a zero-dependency in-memory backend, so a working store is one layer —
`KvTriples.layer`:

```ts
import { Effect } from "effect";
import { KvTriples, Triples, string } from "@bjacobso/triplex";

const program = Effect.gen(function* () {
  const triples = yield* Triples;

  yield* triples.assert({
    entityId: "person:alice",
    attribute: ":person/name",
    value: string("Alice"),
  });

  // triple-pattern read
  const facts = yield* triples.match({ attribute: ":person/name" });

  // Datalog read
  const { results } = yield* triples.query({
    find: ["?name"],
    where: [["?person", ":person/name", "?name"]],
  });

  return results; // => [{ "?name": "Alice" }]
});

Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer)));
```

For a runnable version that writes linked entities and reads them through both
triple matching and Datalog, run `pnpm example:demo` or see
[`examples/demo`](examples/demo).

For the application boundary around compliance derivations, run
`pnpm example:compliance-host` or see
[`examples/compliance-host`](examples/compliance-host). It demonstrates a
Triples-backed config release, transaction-feed catch-up, hypothetical planning,
durable requirement occurrences, host-owned scheduling, and expiry-driven
reopening as one self-verifying scenario.

Applications replacing the older vendored fact store can follow
[`docs/onboarded-foundation.md`](docs/onboarded-foundation.md) for database-per-organization
wiring, package/API mapping, data migration, RequestResolver batching, and journal consumption.

`Triples` is the store's one service: `assert`/`transact` and both read paths —
`match` for triple patterns, `query` for Datalog — are methods on it.
`SnapshotService`, `SubscriptionManager`, and `DatabaseManager` remain separate,
optional services with their own consumers. There is no fluent `Database` facade —
you compose the services you need and provide one storage `Layer`.

## Typed configuration

Configuration is a first-class module of the primary package, exposed through a
tree-shakeable subpath rather than flattening its symbols into the root:

```ts
import { Triples } from "@bjacobso/triplex";
import {
  ConfigRuntime,
  ConfigStore,
  EntityValidation,
  Evaluate,
  GraphConstraint,
  TypeExpr,
} from "@bjacobso/triplex/config";
```

`TypeExpr` describes runtime-defined types as content-addressed data. Config nodes form
immutable Merkle graphs; commits produce `ConfigSnapshot` release roots containing
revisions, schema stamps, and dependency closures. Git-style refs such as `live` and
`test` can move between releases without copying configuration.

The ontology DSL keeps three identities separate: PascalCase entity types, lowercase
namespaced attribute keywords, and ergonomic TypeScript property aliases. Attribute
requiredness and cardinality belong to an entity's use of a global attribute—not to the
attribute definition itself:

```ts
import { Attribute, EntityType } from "@bjacobso/triplex/config";

export const EmployerName = Attribute.text(":employer/name");

export const Employer = EntityType.make("Employer", {
  attributes: {
    name: Attribute.use(EmployerName, { required: true, unique: true }),
  },
});

export const EmployerSummary = EntityType.make("EmployerSummary", {
  attributes: {
    name: Attribute.use(EmployerName, { required: false }),
  },
});

export const EmploymentEmployer = Attribute.ref(":employment/employer", Employer);

Employer.name.key; // ":employer/name"
Employer.name.assertion("Acme", { validFrom });
```

`Employer.nodes` yields the independently addressed attribute definitions followed by the
entity-schema node for committing into a release. Required, cardinality-one, uniqueness, and
reference-target rules are independently content-addressed `GraphConstraint` children of that
schema node. The schema references each global attribute, while reference attributes and their
constraints also point to the target entity type.
An assertion is a typed command descriptor (`attribute`, encoded Triple value, and optional
domain `validFrom`); an application command decides how domain-valid time maps onto its fact
model, while raw `Triples.transact` continues to record transaction time.

`ConfigStore.layer` persists those objects through any `Triples` implementation and
commits a release plus an optional ref move in one Triples transaction. It preserves
deduplication, structural sharing, schema compatibility, and `validUnder` history while
using Datalog for reverse-dependency and deploy-impact candidates. The immutable
`InMemoryConfigStore` remains available as the reference implementation. `Evaluate`
produces reproducible decision proofs, and `Evaluate.verify` checks their internal
content-addressed integrity without replacing Merkle verification with database queries.

`ConfigRuntime.evaluate` is the storage-to-proof bridge: it resolves a release ref, builds
the rule catalog from that exact `ConfigSnapshot`, reads only the temporal Triple facts
the rule can observe, and returns the pinned evaluation:

```ts
const decision =
  yield *
  ConfigRuntime.evaluate({
    ref: "live",
    rule: "may-deploy",
    subject: "employee:alice",
    clock: { now: Date.now(), granularity: "day" },
  });

ConfigRuntime.verify(decision); // []
```

The decision ID binds the selected release root, subject, reason, and nested evaluation;
changing the configuration pin or proof breaks `ConfigRuntime.verify`. This is tamper
evidence given a trusted decision root, not independent proof that the pinned rule was
authorized or semantically correct. Passing `asOf`
evaluates the same deployed rule against historical facts. Cardinality is
explicit: a rule read with multiple live Triple values fails instead of selecting one
arbitrarily, and non-scalar JSON facts are rejected at the bridge.

### Validating facts against deployed types

Entity types can be configuration too. Define a closed runtime shape using the exact
Triple attribute names, commit it with the rest of the release, and explicitly revalidate
after moving a config ref or changing facts:

```ts
const employeeSchema =
  yield *
  EntityValidation.define(
    "Employee",
    TypeExpr.struct({
      ":employee/name": TypeExpr.required(TypeExpr.text),
      ":employee/age": TypeExpr.required(TypeExpr.integer),
    }),
  );

yield *
  configStore.commit({
    label: "employee schema v2",
    objects: [employeeSchema],
    ref: "live",
  });

const validation = yield * EntityValidation.EntityValidation;
yield * validation.revalidate({ ref: "live" });

const validationState = yield * validation.currentInvalid("live");
if (validationState.status === "stale") {
  console.log(`validation is stale as of ${validationState.sourcePosition}`);
}
const invalidNow = validationState.invalid;
const invalidAtLeastOnce = yield * validation.everInvalid();
const messages = yield * validation.violations({ subject: "employee:alice" });
```

Every result is bound to the exact `ConfigSnapshot`, schema `ContentId`, subject, and a
domain-separated content ID for the materialized entity state. The entity body itself is
not copied into validation storage. Results and individual violations are immutable,
content-addressed entities under reserved Triplex attributes. Revalidation atomically
moves a `(ref, entity type, subject)` head; fixing an entity removes it from the current
invalid query without erasing that it was invalid before. `currentInvalidQuery`,
`lastInvalidQuery`, `everInvalidQuery`, and `violationsQuery` return ordinary Datalog queries for composing
validation state with the rest of an application's graph.

Schemas built through `EntityType.make` also evaluate their graph constraints during the same
revalidation pass. Violations use stable `required`, `cardinality`, `unique`, and
`reference-target` codes and retain the responsible constraint key as an ordinary reserved fact.
`GraphConstraint.evaluate` can run the same definitions read-only at an explicit bitemporal basis.

Applications may also enforce the exact release's portable graph constraints inside an operational
transaction:

```ts
const snapshot = yield * config.resolveRef("live");
const constraints = yield * GraphConstraint.collect(snapshot.root);

yield *
  triples.transact(operations, {
    actor: "agent:worker-7",
    configSnapshot: snapshot.id,
    enforce: GraphConstraint.enforcement(constraints),
  });
```

Enforcement projects the complete transaction before mutation and checks every represented
valid-time boundary, including future-effective intervals. A new or worsened required,
cardinality, uniqueness, or reference-target violation fails with `ConstraintViolationError` and
rolls back the facts, journal, command receipt, and commit position together. Unchanged legacy
violations do not block unrelated commands or repairs. KV, SQLite, and PostgreSQL serialize this
check through the same commit-position boundary used by the journal, so concurrent Triplex writers
cannot both win a uniqueness or absence check. Candidate loading uses source and reference-target
type indexes plus batched subject reads, so unrelated live facts are not scanned.
When a retraction and assertion replace the recorded value for the same business-time interval,
carry the original fact's `validFrom`; using the transaction instant intentionally changes the
currently-known valid-time history and is checked as such.

Revalidation is an explicit checkpointed projection in this release. Each run records the
latest causal transaction position it observed. `currentInvalid` reports `unvalidated`,
`current`, or `stale`, and stale responses retain the last known errors instead of silently
returning an empty set. Use `transact` for operational writes so they participate in this
freshness boundary; standalone low-level writes do not create causal envelopes. These
observations remain useful for migration, audit, and finding stale data. Enforcement is explicitly
opt-in per command: raw `assert`, unconstrained `transact`, and direct adapter writes remain a fact
store boundary. Authorization and general Datalog policy invariants remain host responsibilities.

The browser example at [`examples/config-explorer`](examples/config-explorer) walks
through typed nodes, releases, refs, impact, evaluation, and proof verification.

## Portable derivations

`@bjacobso/triplex/derivation` turns a pinned structural Datalog query into typed,
content-addressed candidates without inventing application workflow objects:

```ts
import * as Derivation from "@bjacobso/triplex/derivation";

const openI9 =
  yield *
  Derivation.make({
    name: "task.i9",
    configSnapshot: deployedSnapshot.id,
    identity: ["?worker", "?scope"],
    query: {
      find: ["?worker", "?scope"],
      where: [
        ["?placement", ":placement/worker", "?worker"],
        ["?placement", ":placement/employer", "?scope"],
        ["not", ["?worker", ":submission/i9", "?scope"]],
      ],
    },
  });

const evaluation =
  yield *
  Derivation.evaluate(triples, openI9, {
    basis: { validAt: Date.now() },
  });

if (evaluation.nextTemporalBoundary !== undefined) {
  scheduler.wakeAt(evaluation.nextTemporalBoundary, openI9.id);
}
```

Repeated graph paths with the same declared identity produce one candidate whose source
triple and transaction provenance is merged. Candidate identity remains stable across
definition revisions; its revision changes when the result, definition, configuration pin,
or explanation changes. `Derivation.reconcile` classifies candidates as `added`, `removed`,
`changed`, or `unchanged`, so an application can create durable requirement occurrences or
tasks at its own command boundary. Definitions also expose discovered attribute dependencies
for transaction-feed-driven invalidation.

This first release intentionally accepts complete structural queries with patterns,
predicates, and negation—no rules, disjunction, aggregation, or pagination—so exact positive
source provenance is well-defined. Evaluation is read-only and storage-independent. Durable
checkpoints are available through `Derivation.Materialization`:

```ts
yield *
  Derivation.Materialization.materialize(triples, openI9, {
    basis: { validAt: now },
  });

const state =
  yield *
  Derivation.Materialization.current(triples, openI9, {
    basis: { validAt: now },
  });

let nextTemporalBoundary = state.nextTemporalBoundary;
if (state.status !== "current") {
  const next =
    yield *
    Derivation.Materialization.materialize(triples, openI9, {
      basis: { validAt: now },
    });
  scheduleReconciliation(next.reconciliation);
  nextTemporalBoundary = next.nextTemporalBoundary;
}

if (nextTemporalBoundary !== undefined) {
  scheduler.wakeAt(nextTemporalBoundary, openI9.id);
}
```

Candidate revisions and runs are immutable Triples system entities. A run atomically records its
candidate set, configuration pin, bitemporal basis, and latest relevant transaction position.
Freshness is dependency-scoped, so unrelated transactions do not make a materialization stale;
definition changes, relevant writes, and a different temporal basis do. Concurrent runs select a
logical head by source position within a definition rather than racing a mutable pointer. Stored
candidate bodies are schema-decoded and their content IDs are verified when read. Historical run
membership is also available as ordinary Datalog through `Materialization.runsQuery`.

For fixed dependency sets, `triples.dependencyState(attributes, basis)` computes that source
position and temporal schedule through backend indexes. It includes assertion and retraction
positions while deriving wakeups only from facts visible in the requested recorded-time view.

Every evaluation also reports the earliest future `validFrom` or `validTo` among facts using a
discovered dependency attribute. This conservative schedule includes facts that currently suppress
a result through negation, so expiring evidence can reopen an obligation even when the current
candidate set is empty. Materialized runs persist and content-bind the same
`nextTemporalBoundary`; a host scheduler wakes the materializer there and owns timer delivery and
retry. The schedule is attribute-conservative, so an unrelated entity sharing a dependency
attribute may cause a harmless extra wakeup, but recorded future-effective or expiring facts are
not omitted.

Read-only planners can evaluate temporary assertions and retractions through
`Derivation.Overlay`:

```ts
const preview =
  yield *
  Derivation.Overlay.evaluateOverlay(triples, openI9, {
    basis: { validAt: now },
    overlay: {
      assertions: [proposedPlacementWorker, proposedPlacementEmployer],
      retractions: [supersededPlacementFactId],
    },
  });
```

The overlay copies only the definition's discovered attributes at the requested bitemporal basis
into a fresh private in-memory index and runs the normal KV Datalog evaluator. It never writes to
the source store or its transaction journal. Temporary facts receive deterministic content IDs and
appear in candidate sources as `hypothetical: true`; base sources retain their real triple and
transaction provenance. This makes collect-versus-reuse previews comparable to committed
evaluation without pretending the preview happened.

Overlay evaluation currently requires fixed attributes and rejects transaction-binding clauses.
Provenance through recursive rules remains future work. Fixed-attribute materializations use the
backend dependency indexes; dynamic-attribute definitions retain the slower journal fallback
because no bounded attribute lookup can preserve their semantics.

## Triples and values

A fact is asserted from a `TripleInput`:

```ts
interface TripleInput {
  entityId: string;
  attribute: string; // ":namespace/name" convention
  value: TripleValue;
  entityType?: string; // optional class tag, e.g. "Person"
  createdBy?: string;
}
```

Values are tagged, not raw JavaScript. Construct them with the helpers exported from
the package root — this keeps the stored type explicit and makes references
first-class:

| Helper                              | Value type | Example                                         |
| ----------------------------------- | ---------- | ----------------------------------------------- |
| `string(v)`                         | `string`   | `string("Alice")`                               |
| `number(v)`                         | `number`   | `number(30)`                                    |
| `boolean(v)`                        | `boolean`  | `boolean(true)`                                 |
| `datetime(v)`                       | `datetime` | `datetime(Date.now())` / `datetime(new Date())` |
| `ref(entityId)`                     | `ref`      | `ref("person:bob")`                             |
| `json(v)`                           | `json`     | `json({ tags: ["a", "b"] })`                    |
| `blob(hash, mimeType, size, name?)` | `blob`     | `blob("sha256:…", "image/png", 2048)`           |

`ref` values link entities together and are what graph-style queries traverse. A
`datetime` is stored as epoch milliseconds.

Datalog constants use scalar equality unless their type is explicit. A bare string such as
`"person:bob"` matches stored `string`, `ref`, `blob`, or serialized `json` values with that scalar;
a bare number matches both `number` and `datetime` values with that scalar. Positive patterns,
negation, disjunction, joins, and predicates all use this same identity. Use a typed constant such
as `ref("person:bob")` when the pattern must match only a stored `ref`. Query bindings and projected
results remain unwrapped JavaScript scalars.

Assert one fact, a batch, or an atomic transaction, and read facts back by entity or
by pattern:

```ts
import { number, ref, string, Triples } from "@bjacobso/triplex";

Effect.gen(function* () {
  const triples = yield* Triples;

  // one fact
  const triple = yield* triples.assert({
    entityId: "person:alice",
    attribute: ":person/name",
    value: string("Alice"),
    entityType: "Person",
  });

  // many facts at once
  yield* triples.assertBatch([
    { entityId: "person:alice", attribute: ":person/age", value: number(30) },
    { entityId: "person:bob", attribute: ":person/name", value: string("Bob") },
    { entityId: "person:alice", attribute: ":person/knows", value: ref("person:bob") },
  ]);

  // an atomic transaction with a queryable causal envelope
  const tx = yield* triples.transact(
    [
      { op: "assert", entityId: "person:carol", attribute: ":person/name", value: string("Carol") },
      { op: "retract", id: triple.id },
    ],
    {
      actor: "service:importer",
      commandId: "import:2026-09-01:carol",
      correlationId: "import:2026-09-01",
      configSnapshot: "sha256:…",
    },
  );

  // reads
  const alice = yield* triples.entity("person:alice"); // all facts for the entity
  const names = yield* triples.match({ attribute: ":person/name" }); // by pattern
  return { tx: tx.txId, position: tx.position, alice, names };
});
```

A query pattern is `{ entityId?, attribute?, entityType?, value? }`; omitted fields
match anything. Writes never mutate in place — `retract` and `retractByPattern` stamp a
fact as retracted rather than deleting it, which is what makes the store temporal.

## Temporal facts and time travel

Because retraction is a stamp, not a delete, every fact carries `recordedAt` and an
optional `retractedAt`, plus its `validFrom`/`validTo` business-time interval. The full
timeline of an entity is always recoverable. Two
methods expose this directly:

```ts
Effect.gen(function* () {
  const triples = yield* Triples;

  // Point-in-time: facts that were recorded and valid at the given instant.
  const lastWeek = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const asOfLastWeek = yield* triples.match(
    { attribute: ":person/name" },
    { recordedAt: lastWeek, validAt: lastWeek },
  );

  // full assertion/retraction history for one entity
  const timeline = yield* triples.history("person:alice");

  return { asOfLastWeek, timeline };
});
```

Each `transact` writes a synthetic `_Transaction` entity containing a backend-issued
`:_tx/position`, `:_tx/instant`, actor, command, correlation, causation, governing config snapshot,
and JSON change facts. Read one typed envelope with `triples.transaction(txId)`, query the reserved
attributes through Datalog, or find the receipt with
`triples.transactionByCommand(commandId)`. A `commandId` is atomically unique within one Triplex
database. A retry fails with `CommandAlreadyCommittedError`, which identifies the original
transaction, and commits none of the repeated operations.

Catch up in commit order and persist the position only after the page's effects are durable:

```ts
import { ConsumerCheckpoint } from "@bjacobso/triplex/operational";

const consumer = "search-index/v1";
const checkpoint = yield * ConsumerCheckpoint.get(triples, consumer);
const after = checkpoint?.position ?? 0;
const page = yield * triples.transactions({ after, limit: 100 });

for (const transaction of page.transactions) {
  yield * handleAtLeastOnce(transaction);
}

if (page.next !== undefined) {
  yield *
    ConsumerCheckpoint.advance(triples, {
      consumer,
      expectedPosition: after,
      nextPosition: page.next,
    });
}
```

The cursor is committed atomically with the journal, so a failed transaction cannot appear in the
feed. Consumer checkpoint maintenance is an atomic reserved fact update and is deliberately omitted
from the feed so a consumer cannot recursively consume its own cursor writes. Concurrent checkpoint
movement uses compare-and-retract and returns `ConsumerCheckpointConflictError` to the stale worker.
Best-effort `ChangeEmitter` notifications remain only a wake-up hint; consumers always catch up from
their durable checkpoint.

### Conditional transactions

Moving facts can use compare-and-retract semantics. A `TripleLive` precondition must name a triple
also retracted by the transaction. If another writer retracts it first, the entire transaction
rolls back with `TransactionConflictError`:

```ts
const current = (yield *
  triples.match({
    entityId: "task:42",
    attribute: ":task/status",
  }))[0]!;

yield *
  triples.transact(
    [
      { op: "retract", id: current.id },
      {
        op: "assert",
        entityId: "task:42",
        attribute: ":task/status",
        value: string("claimed"),
      },
    ],
    {
      actor: "agent:worker-7",
      commandId: "claim:task:42",
      preconditions: [{ _tag: "TripleLive", id: current.id }],
    },
  );
```

This is the primitive used by config-ref, entity-validation-head, and consumer-checkpoint movement.
It is suitable for task claims, leases, and optimistic form updates. `Triples.transact` is atomic on
both SQL and KV backends; the in-memory KV backend also serializes concurrent transactions. Use
`transact` with causal metadata for operational commands; the convenience write methods still use
the same atomic boundary but do not accept that metadata.

## Datalog queries

Datalog is the primary query language. Call `triples.query(query)`; it resolves to
`{ results }`, where `results` is an array of binding objects whose keys keep the `?`
prefix. `find` lists the variables (or constants) to project; `where` is a list of
clauses. Sharing a variable across two patterns joins them.

Every backend runs the same schema and semantic preflight before compilation or execution.
Malformed runtime input fails with `DatalogValidationError`; a variable referenced by `find`, a
predicate, `having`, ordering, or a wrapper without a positive binding fails with
`UnboundVariableError`. These are typed Effect failures rather than backend exceptions. Empty
disjunctions, duplicate projections, undefined rules, and ambiguous aggregate/projection targets
are rejected consistently instead of being interpreted differently by KV and SQL.

### Patterns and joins

```ts
// implicit join on ?person across two patterns
triples.query({
  find: ["?name", "?age"],
  where: [
    ["?person", ":person/name", "?name"],
    ["?person", ":person/age", "?age"],
  ],
});
// results => [{ "?name": "Alice", "?age": 30 }, ...]
```

Pass one temporal basis for the complete query—including joins, negation, optional
projection, and recursive rules:

```ts
yield *
  triples.query(query, {
    basis: { recordedAt: someEpochMillis, validAt: someEpochMillis },
  });
```

A pattern is `[entity, attribute, value]`. Any position may be a variable (`"?x"`) or a
constant. To match a `ref` value, use a typed constant:

```ts
where: [["?movie", ":movie/director", { type: "ref", value: "person:nolan" }]];
```

### Predicate filters

Inline comparison clauses filter bound variables. Operators: `>`, `>=`, `<`, `<=`,
`=`, `!=`.

```ts
triples.query({
  find: ["?name", "?age"],
  where: [
    ["?person", ":person/name", "?name"],
    ["?person", ":person/age", "?age"],
    [">=", "?age", 30],
  ],
});
```

### Negation and disjunction

`where` is declarative: positive patterns establish bindings before predicates, negation, and
disjunction regardless of their written order. Patterns inside a conjunctive `not` likewise bind
its local variables before local predicates run.

```ts
// people who are NOT inactive
where: [
  ["?person", ":person/name", "?name"],
  ["not", ["?person", ":person/status", "inactive"]],
];

// Alice OR Bob
where: [
  [
    "or",
    [
      ["?person", ":person/name", "Alice"],
      ["?person", ":person/name", "Bob"],
    ],
  ],
];
```

### Aggregation, ordering, and limits

`aggregate` clauses are `[op, sourceVar, targetVar]` with `count`, `sum`, `avg`, `min`,
`max`; grouping is implicit over the non-aggregated `find` variables. `having`,
`orderBy`, `limit`, and `offset` are also supported. Grouping, all five aggregate operators, and
`having` share one conformance contract across KV, SQLite, and PostgreSQL.
The aggregate source is an input and must not also appear in `find`; project its target and any
grouping variables instead. Aggregate and optional-projection targets must be projected, while
`having` and `orderBy` may reference only result bindings.
Group-key equality in `having` preserves the same numeric, boolean, and text scalar families as
ordinary Datalog equality. Aggregate targets are numeric, so comparing one to a nonnumeric literal
or identity binding fails typed preflight; optional projections are hydrated after aggregation and
cannot be used in `having`.
`count` counts distinct flattened source values. `sum`, `avg`, `min`, and `max` preserve duplicate
input rows. An ungrouped aggregate over no matches returns one row with `count` equal to zero and
the numeric aggregates equal to `null`; an empty grouped aggregate returns no rows.

Raw Datalog `>`, `>=`, `<`, and `<=` predicates are numeric-only. Their variables must be bound
from fact values, numbers and datetimes share the numeric family, and literal operands must be
numbers. Text and identity comparisons use `=` or `!=`; invalid ordered predicates fail during
typed preflight instead of relying on backend coercion. Entity, attribute, transaction, and rule
identities are strings: equality with a numeric or boolean literal is always false, and inequality
is always true, consistently across backends. Pattern entity, attribute, and transaction positions
therefore accept only string literals or variables; explicit typed refs are value constants.
The `?` prefix is reserved for variables and variable names must match `?name`-style identifiers;
malformed names fail decoding before SQL is built. Constants projected from `find` keep their
primitive value across direct and paginated queries, with typed refs flattened to their string ID.

```ts
triples.query({
  find: ["?count"],
  where: [["?person", ":person/age", "?age"]],
  aggregate: [["count", "?person", "?count"]],
});
// results => [{ "?count": 3 }]
```

### Stable cursor pagination

`queryPage` uses an opaque, versioned keyset cursor. Triplex completes the requested order with
every projected variable as a deterministic tie-breaker, pins the first page's exact recorded
commit position and valid/recorded-time basis, and binds the cursor to the canonical query and
database scope. Later assertions and
retractions therefore do not move rows between pages. Reusing a cursor with different filters,
ordering, basis, or organization fails with a typed `PaginationCursorError`; malformed base64 or
JSON never escapes as an unchecked exception.

Wrapper filters operate on the same typed scalar results returned to callers. Numeric and datetime
values compare numerically; text, refs, blobs, and JSON compare as text; incompatible families and
`null` do not satisfy either positive or negative comparison operators. `is-null` and
`is-not-null` take no operand, while every other operator requires one. Invalid filter shapes fail
with `DatalogValidationError` before reaching a backend.

Direct ordering and cursor pagination share one typed total order across backends: numbers and
datetimes first, booleans second, text-family values third, and `null` last. The requested direction
orders values within each family; a deterministic entity tie-breaker makes every page boundary
unique. Datalog result identity follows those same public scalar families: numbers and datetimes
with the same numeric value are one result, as are strings, refs, blobs, and JSON with the same text
value. SQL applies that identity before `DISTINCT`, grouping, counting, and pagination, then keeps
the physical sort and decoding columns out of the returned context. Direct triple reads still
preserve the original stored value type.

```ts
const first =
  yield *
  triples.queryPage({
    inner: {
      find: ["?person", "?name"],
      where: [["?person", ":person/name", "?name"]],
    },
    orderBy: [{ variable: "?name", direction: "asc" }],
    limit: 50,
  });

const second = first.nextCursor
  ? yield *
    triples.queryPage({
      inner: {
        find: ["?person", "?name"],
        where: [["?person", ":person/name", "?name"]],
      },
      orderBy: [{ variable: "?name", direction: "asc" }],
      limit: 50,
      cursor: first.nextCursor,
    })
  : undefined;
```

Treat cursors as short-lived capabilities and never decode or edit them in application code.

### Transaction provenance

Bind the transaction id as an optional fourth pattern element, then join it against the
transaction metadata entity written by `transact`:

```ts
where: [
  ["?e", ":person/name", "?name", "?tx"],
  ["?tx", ":_tx/actor", "?actor"],
];
```

### Recursive rules

Recursive rules (e.g. ancestor/descendant closures) run through `triples.query` like any
other query — provide `rules` alongside `find`/`where`. Each rule is
`{ name, body, maxDepth? }`, and same-named rules union together. A rule-application
clause `["ancestor", "person:alice", "?ancestor"]` invokes a rule. SQL backends compile
rules to recursive CTEs; KV backends evaluate them to a fixpoint with deduplication. Rule names
may contain letters, digits, underscores, and hyphens; recursion depth is a positive safe integer.
SQL compilation quotes rule identifiers and parameterizes rule bodies, applications, and depth.
The current portable recursive form is deliberately binary: one base relationship plus recursive
definitions shaped as `[head, attribute, next]`, `[ruleName, next, tail]`. Unsupported rule-body
shapes fail preflight rather than being partially evaluated by one backend.

```ts
triples.query({
  find: ["?ancestor"],
  where: [["ancestor", "person:alice", "?ancestor"]],
  rules: [
    { name: "ancestor", body: [["?x", ":parent", "?y"]] },
    {
      name: "ancestor",
      body: [
        ["?x", ":parent", "?z"],
        ["ancestor", "?z", "?y"],
      ],
    },
  ],
});
```

The compile-only entrypoint is still available for tooling: `compileWithRules(query)`
returns the SQL and params without executing.

## Entity snapshots and subscriptions

`SnapshotService` materializes the current or historical state of one triple entity as
an `EntitySnapshot`: a canonicalized, content-hashed record useful for change detection,
sync, and audit:

```ts
import { SnapshotService } from "@bjacobso/triplex";

Effect.gen(function* () {
  const snapshots = yield* SnapshotService;
  const now = yield* snapshots.current("person:alice");
  const earlier = yield* snapshots.asOf("person:alice", someEpochMillis);
  const changes = yield* snapshots.diff("person:alice", fromTxId, toTxId);
  return { now, earlier, changes };
});
```

`SubscriptionManager` powers reactive/live queries. Register a Datalog query under an
id; as facts change, `checkAffected` reports which subscriptions are invalidated. There
is no `store.subscribe(...)` method — this dependency-tracking model, together with
`TopicFilteredSyncHub` for websocket-style push, is the building block for live queries
and client sync.

An `EntitySnapshot` is not a configuration release. `ConfigSnapshot`, exported from
`@bjacobso/triplex/config`, is an immutable root for a complete typed configuration
release. The names and APIs remain separate so a point-in-time entity materialization
cannot be confused with a deployable configuration graph.

```ts
import { SubscriptionManager } from "@bjacobso/triplex";

Effect.gen(function* () {
  const subs = yield* SubscriptionManager;
  yield* subs.register("active-people", {
    find: ["?name"],
    where: [
      ["?p", ":person/name", "?name"],
      ["?p", ":person/status", "active"],
    ],
  });
  const affected = yield* subs.checkAffected(changes); // from a write's change set
  return affected;
});
```

## Storage backends

The core package runs entirely in memory. Durable backends are separate packages that
provide the same `Triples` service over a real store, each with a one-line convenience
layer.

| Package                          | Convenience layer                        | Runtime                                        |
| -------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `@bjacobso/triplex`              | `KvTriples.layer` (in-memory)            | Node.js 22+, browsers, edge runtimes           |
| `@bjacobso/triplex-sql`          | shared SQL query executor                | SQL-capable runtimes                           |
| `@bjacobso/triplex-sqlite`       | `SqliteTriples.layer({ filename })`      | Node.js 22+                                    |
| `@bjacobso/triplex-postgres`     | `PgTriples.layer(config)`                | Node.js 22+                                    |
| `@bjacobso/triplex-cloudflare`   | Cloudflare Durable Object SQLite adapter | Cloudflare Workers                             |
| `@bjacobso/triplex-foundationdb` | `FdbTriples.layer(config)`               | Node.js 22+ with FoundationDB client libraries |
| `@bjacobso/triplex-testkit`      | `makeTriplesConformanceSuite` + fixtures | Node.js 22+                                    |

A durable stack is a single convenience layer. For SQLite:

```ts
import { SqliteTriples } from "@bjacobso/triplex-sqlite";

const SqliteLive = SqliteTriples.layer({ filename: "app.db" });
// or SqliteTriples.layerMemory for an in-memory database
```

The rest of your program is unchanged — it still depends only on the `Triples` service
tag. For manual wiring, provide `TriplesLive` over a `StorageAdapter`, a
`QueryExecutor` (`SqlQueryExecutorLive`), and a `TripleStoreRuntime`.

## Entrypoints

The package root exports the triples, query, entity-snapshot, and subscription APIs.
Typed configuration stays under `@bjacobso/triplex/config`, and shared content-addressing
primitives stay under `@bjacobso/triplex/content`. Portable derivations stay under
`@bjacobso/triplex/derivation`, while durable feed-consumer primitives stay under
`@bjacobso/triplex/operational`, keeping these entrypoints tree-shakeable.

The core package also exposes tree-shakeable ESM subpaths for focused schemas and
types:

```ts
import { TripleInput, TransactOp, Pattern } from "@bjacobso/triplex";
import { DatalogQuery } from "@bjacobso/triplex/datalog";
import { SubscriptionManager } from "@bjacobso/triplex/subscriptions";
import { ConfigStore, TypeExpr } from "@bjacobso/triplex/config";
import { ContentId } from "@bjacobso/triplex/content";
import * as Derivation from "@bjacobso/triplex/derivation";
import { ConsumerCheckpoint } from "@bjacobso/triplex/operational";
```

The root exports the `Triples` and `SnapshotService` runtime tags and their domain types.
Triplex does not impose an HTTP or RPC transport contract; applications expose the core
services through the transport that fits their runtime. Transaction history belongs to
the authoritative `Triples.transaction` and `Triples.transactions` journal APIs rather
than the entity-snapshot projection.

## Content IDs and storage baseline

Triplex uses one browser-safe content-addressing foundation: deterministic canonical
encoding followed by domain-separated SHA-256. A `ContentId` is formatted as
`sha256-<64 lowercase hex characters>`, with distinct domains for entity snapshots,
config nodes, closures, stamps, types, evaluations, release-pinned decisions, and observations.

The SQL packages expose one v1 migration containing the complete current schema. Triplex
is greenfield: there is no v2 upgrade path or alternate KV codec, so databases created by
development builds before this baseline must be recreated.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

The regular test suite is self-contained. PostgreSQL and FoundationDB integration tests
are opt-in because they require Docker or native client libraries. See
[CONTRIBUTING.md](./CONTRIBUTING.md), and [ARCHITECTURE.md](./ARCHITECTURE.md) for the
package dependency graph.

## Roadmap

Planned work is tracked in [docs/roadmap.md](./docs/roadmap.md), including general Datalog
invariants, reactive "live" queries, integrated full-text search, query optimization, and
client-side sync / offline-first support.

## License

MIT © 2026 Ben Jacobson.
