# Onboarded foundation guide

Triplex can provide Onboarded's fact, temporal-query, configuration, and derivation substrate
without importing application concepts into the database. Onboarded should retain its own
`EntityStore`, authorization, command handlers, durable requirement occurrences, Threads,
Routines, forms, and HTTP contracts as adapters over these primitives.

The executable companion is [`examples/compliance-host`](../examples/compliance-host/README.md).
It publishes generic configuration, writes facts pinned to that release, evaluates a Datalog
derivation with provenance, reconciles candidates into durable host-owned work, previews a
hypothetical submission, and reopens work at an evidence-expiry boundary.

## Guarantees available now

- One atomic `Triples.transact` boundary for assertions, retractions, optimistic `TripleLive`
  preconditions, the ordered commit position, and the causal journal.
- Typed facts with independent recorded and valid time. Direct reads, batched reads, and every
  Datalog clause share one temporal basis.
- Complete transaction changes containing the old or new typed value, interval, triple identity,
  entity identity/type, assertion transaction, and retraction transaction.
- Actor, command, correlation, causation, and config-snapshot metadata, plus ordered catch-up with
  `transactions({ after })` and indexed command-ID lookup.
- Database-per-organization isolation. PostgreSQL `DatabaseManager` validates logical database
  IDs and binds every pooled connection to a deterministic, safely quoted physical schema.
- Typed opaque page cursors. The envelope is versioned and bound to the canonical query, complete
  deterministic ordering, bitemporal basis, and database scope; malformed or reused cursors fail
  with `PaginationCursorError`.
- Content-addressed config releases and movable refs, runtime `TypeExpr` evaluation, explicit
  entity-validation observations, decision proofs, and structural Datalog derivations with source
  triple/transaction provenance.

These are database guarantees, not authorization guarantees. Selecting the organization database
is part of Onboarded's authenticated request boundary and must happen before exposing `Triples` to
domain code.

## Package and API mapping

| Vendored package or API              | Triplex replacement                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `effect-triples`                     | `@bjacobso/triplex`                                                                    |
| `MemoryTriplesLive`                  | `KvTriples.layerWithScope(databaseId)`                                                 |
| `Triples`                            | `Triples`                                                                              |
| `TripleStorage`                      | Internal `StorageAdapter`; application code should depend on `Triples`                 |
| `effect-triples-sql`                 | `@bjacobso/triplex-sql` for host-owned migrations and SQL execution                    |
| `effect-triples-sqlite`              | `@bjacobso/triplex-sqlite`; use `SqliteTriples.layer(...)`                             |
| `effect-triples-postgres`            | `@bjacobso/triplex-postgres`; use `DatabaseManager` for organization schemas           |
| vendored conjunctive `Triples.query` | Triplex raw Datalog `Triples.query`                                                    |
| per-tenant matching                  | Select one organization `Triples` service, then call `match`/`entity`/`entities`       |
| `transactionsForEntity`              | Read the ordered journal and filter its typed `changes`, or maintain a host projection |
| in-process `changes` stream          | Best-effort wakeup plus durable `transactions({ after })` catch-up                     |

There are intentionally no compatibility exports for old package names or `@open-ontology/*`.

## One database per organization

Persist a catalog mapping from Onboarded `AccountId` to a validated Triplex `DatabaseId`. Do not
derive authorization from a caller-provided schema name. At request entry:

1. authenticate the actor and resolve their account membership;
2. load the server-owned `DatabaseId` mapping;
3. obtain that database from `DatabaseManager`;
4. provide only its scoped `Triples` service to the request program; and
5. keep authorization checks in the Onboarded command/query layer.

`DatabaseManager` is the PostgreSQL production boundary. It creates a collision-resistant schema,
configures every pool connection for exactly that schema, and gives pagination cursors the logical
database scope. Never share the registry/system `SqlClient` as an organization fact client.

SQLite should use one file per organization:

```ts
const OrganizationTriples = SqliteTriples.layer({
  filename: `/var/lib/onboarded/triplex/${databaseId}.sqlite`,
});
```

Tests and ephemeral programs should use an explicitly named isolated KV store:

```ts
const OrganizationTriples = KvTriples.layerWithScope(databaseId);
```

The host owns the map from account to file/layer and must not cache a `Triples` service under an
untrusted account string.

## Migrating `effect_triples`

Migration is per tenant because `tenant_id` becomes the physical organization-database boundary.
Run it while writes are stopped or dual-written and verified. For every distinct legacy
`tenant_id`, provision its mapped Triplex database and copy rows with this field mapping:

| Legacy `effect_triples`                                                                       | Triplex `triples`    |
| --------------------------------------------------------------------------------------------- | -------------------- |
| `id`                                                                                          | `id`                 |
| `entity_id`, `attribute`, `entity_type`                                                       | same names           |
| `value_type`, `value_string`, `value_number`, `value_boolean`, `value_datetime`, `value_json` | same names           |
| `transaction_id`                                                                              | `tx_id`              |
| `recorded_at`                                                                                 | `recorded_at`        |
| derived from the rebuilt journal                                                              | `recorded_position`  |
| `created_by`                                                                                  | `created_by`         |
| `valid_from`, `valid_to`                                                                      | same names           |
| `retracted_at`                                                                                | `retracted_at`       |
| `retracted_by_transaction_id`                                                                 | `retract_tx_id`      |
| derived from `retracted_by_transaction_id`'s rebuilt journal entry                            | `retracted_position` |
| no legacy column                                                                              | `schema_version = 1` |

Do not copy `tenant_id` into entity IDs. Preserve all assertion and retraction rows. After loading,
allocate transaction commit positions in the legacy recorded order with a deterministic
transaction-ID tie-breaker, and rebuild Triplex `_Transaction` envelopes from the old immutable
transaction entities plus the copied rows' `tx_id`/`retract_tx_id`. Old
`effect-triples/transaction/*` and `effect-triples/entity/revision` facts are application data, not
Triplex's reserved journal format; translate them rather than renaming their attributes in place.
Populate `triplex_command_receipts` from the rebuilt envelopes' command IDs. Treat duplicate legacy
command IDs as a migration error requiring an explicit application decision; never select one
receipt silently.

Before cutover, compare per organization:

- total and live fact counts by value type;
- assertions/retractions grouped by transaction;
- current and historical entity materializations at sampled recorded/valid bases;
- transaction timeline responses; and
- representative Datalog and paginated entity queries.

Run exported Triplex migrations through the host migration system before the copy. Triplex uses
`triplex_schema_migrations`, avoiding the host application's migration table.
Triplex is greenfield and publishes one complete v1 schema migration; it does not upgrade databases
created by earlier development builds.

## Compiling the EntityType DSL

Onboarded remains the owner of the ergonomic TypeScript DSL and application enforcement. Its
compiler should emit one independently identified config node per global attribute and one
entity-type node whose references carry usage-local constraints:

```ts
const EmployerName = Attribute.text(":employer/name");

const Employer = EntityType.make("Employer", {
  attributes: {
    name: Attribute.use(EmployerName, { required: true }),
  },
});
```

The attribute node owns `:employer/name` and its text value type. The `Employer` node references
that attribute and owns `required: true`; the TypeScript property name `name` is only an ergonomic
alias. Form, policy, routine/action, permission, integration, and view nodes can reference those
same keys in one `ConfigStore.commit`. Store the resulting `ConfigSnapshot` ID on every operational
transaction through `meta.configSnapshot`.

Triplex `EntityValidation` now records queryable observations for attribute cardinality, required
facts, reference target types, and uniqueness. It does **not** replace Onboarded's transactional
enforcement or authorization. Keep those checks at the Onboarded command boundary until Triplex
implements and tests enforcement atomically.

## RequestResolver batching

Build Onboarded's resolver above `Triples.entities(ids, basis?)`. Partition requests by the already
authorized organization database and temporal basis, deduplicate entity IDs within each group,
call `entities` once, then associate every result—including missing entities—back to the original
requests. KV performs indexed entity lookups; SQLite and PostgreSQL issue a bounded parameterized
query. Do not issue one cross-organization batch.

The resolver should decode and validate the returned attribute set into Onboarded's `EntityDetail`;
Triplex deliberately does not import that domain type.

## Consuming the journal

An entity transaction endpoint should translate the validated domain command into `TransactOp`s
and call one `Triples.transact` with:

- `actor` from the authenticated principal;
- the API's idempotency key as `commandId`;
- `correlationId` and `causationId` from the request/workflow context;
- the organization's pinned `configSnapshot`; and
- a `TripleLive` precondition for every optimistic revision/status fact being replaced.

Use the returned transaction ID with `transaction(txId)` to construct the API audit result. Each
retraction change includes the old typed value and original assertion transaction; assertion
changes include the replacement. Durable workers page `transactions({ after: checkpoint })`, do
idempotent work, and call `ConsumerCheckpoint.advance` only after side effects commit. Command IDs
are atomically unique per organization database; a duplicate returns the original transaction ID
through `CommandAlreadyCommittedError`, and `transactionByCommand` loads the receipt. Onboarded can
therefore wrap this primitive rather than maintaining a second command-claim table, while retaining
its product-specific response cache and authorization checks.

## Remaining limitations

- Cardinality, uniqueness, required relationships, and reference targets can be observed as
  content-addressed, Datalog-queryable violations, but they and authorization are not yet
  transactionally enforced by core.
- Inbox/outbox records, response caching, retry policy, and timer delivery remain host-owned.
- Derivation provenance currently rejects recursive rules, disjunction, aggregation, and dynamic
  attributes rather than returning an incomplete explanation.
- Entity snapshots and derivation materializations are projections; callers must inspect their
  source position/freshness rather than treating absence as current truth.
- Fixed derivation dependencies use indexed assertion/retraction positions and temporal edges;
  dynamic-attribute definitions fall back to journal replay and should not be used for hot-path
  materializers.
- FoundationDB and Cloudflare remain experimental and are not Onboarded production targets.
- A production migration must be rehearsed against an Onboarded database copy and shadow-compared
  before removing the vendored implementation.
