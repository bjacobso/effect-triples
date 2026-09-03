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

Make command IDs atomically unique per database with typed duplicate receipts, and add Datalog-queryable consumer checkpoints with optimistic advancement under the new `@bjacobso/triplex/operational` subpath.

Add indexed dependency freshness and temporal scheduling across KV, SQLite, and PostgreSQL so fixed-attribute derivations no longer replay the transaction journal.

Add independently content-addressed graph constraints for required attributes, cardinality, uniqueness, and reference targets; generate them from the ontology DSL and materialize their findings as first-class validation facts.

Allow hosts to enforce those same versioned graph constraints atomically in `Triples.transact`, checking complete projected commands across every valid-time boundary and rejecting concurrent uniqueness or absence races with a typed `ConstraintViolationError` on KV, SQLite, and PostgreSQL. Load enforcement candidates through source and reference-target type indexes plus batched subject reads instead of scanning unrelated live facts.

Run recursive Datalog closure through the shared KV, SQLite, and PostgreSQL conformance corpus. Parameterize SQL rule definitions, applications, optional projections, and recursion depths; validate and quote rule identifiers, including schema-supported hyphenated names. Use numbered SQLite placeholders so projection and filter parameters keep their compiler-assigned identities.

Align grouped aggregation, `having`, and declarative clause ordering across KV, SQLite, and PostgreSQL. KV now establishes positive and negation-local bindings before evaluating predicates, so moving a predicate or negation before its binding pattern does not silently change results.

Run Datalog runtime shape and semantic preflight through one backend-neutral validator. Invalid bindings, ambiguous projections and aggregates, empty disjunctions, wrapper column leaks, undefined rules, and unsupported recursive rule bodies now fail with typed query errors before KV or SQL execution.

Align aggregate input multiplicity, distinct counts, and empty-input results across KV, SQLite, and PostgreSQL. Extend typed projection and equality joins to JSON and blob values without string-to-number guessing.

Make wrapped Datalog filters type-aware across KV, SQLite, and PostgreSQL. Validate filter operands before execution, keep negative operators SQL-null compatible, and preserve the physical value columns needed to compare optional numeric projections numerically.

Use one typed total-order key for direct Datalog ordering and cursor pagination across KV, SQLite, and PostgreSQL. Mixed numbers, datetimes, booleans, text-family values, and nulls now retain identical order and stable page boundaries on every supported backend.

Define binary Datalog rules as identity relations, rejecting non-string application arguments and using the same canonical text-family edge encoding across KV, SQLite, and PostgreSQL.

Make raw ordered Datalog predicates explicitly numeric across every engine. Number and datetime value bindings compare without coercing text, boolean, entity, attribute, transaction, or rule bindings, and invalid literal or binding shapes fail in typed preflight rather than leaking SQLite/PostgreSQL behavior.

Canonicalize projected Datalog values before SQL distinctness, grouping, counting, and pagination. Stored number/datetime and string/ref/blob/JSON aliases that flatten to the same public scalar now produce one result on KV, SQLite, and PostgreSQL.

Apply the same flattened scalar identity to Datalog pattern constants across positive patterns, negation, disjunction, and recursive rule bodies. Numeric constants now match numbers and datetimes, text constants include serialized JSON, and explicitly typed refs remain exact on every supported backend.

Keep entity, attribute, transaction, and rule identity bindings string-typed in equality predicates. Numeric and boolean literals now produce deterministic incompatible equality instead of SQLite coercion or PostgreSQL operator failures.

Preserve typed scalar-family equality in grouped `having` filters and require numeric operands whenever an aggregate target participates. Group filters reuse the exact canonical `GROUP BY` expressions required by PostgreSQL. Optional projections now fail preflight when referenced from `having` because they are hydrated only after aggregation.

Restrict pattern entity, attribute, and transaction identities to string literals or variables. Invalid numeric, boolean, and typed-ref identities now fail shared query decoding instead of being stringified by KV or reaching incompatible PostgreSQL comparisons.

Reserve the `?` prefix for validated Datalog variables and preserve constant `find` projections across KV, SQLite, PostgreSQL, and wrapped pagination. Boolean constants retain their public boolean type, typed refs flatten to string IDs, and malformed variable aliases fail before SQL generation.
