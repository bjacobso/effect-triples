# Onboarded

> Onboarded is the operational amplifier between agents and real-world operations.

AI makes intelligence cheap. It does not make operations reliable.

Agents can read documents, make decisions, talk to people, call APIs, and generate work at
enormous speed. Businesses still need a shared understanding of what is true, what is allowed,
what needs to happen, who needs to do it, and why something happened.

Onboarded supplies the world, memory, constraints, coordination, and execution substrate that
lets agent intelligence safely compound. One agent can reason. Onboarded lets thousands of
agents operate.

Onboarding is the first world constructed with the system, not the limit of the system. Workers,
employers, jobs, documents, jurisdictions, policies, forms, background checks, I-9s, approvals,
and integrations become entities and facts. Their processes become threads and routines. Agents
operate the system; Onboarded makes their work durable, structured, governed, and composable.

## The five primitives

### Ontology — what is true

The structured world model: entities, attributes, relationships, facts, runtime types, history,
and derived facts. It represents everything Onboarded knows about workers, companies, jobs,
documents, requirements, jurisdictions, and the relationships among them.

### Threads — what needs attention

The human and agent interaction layer: durable tasks, forms, questions, approvals, document
requests, evidence, comments, assignments, and deadlines. A thread is a durable locus of work
around entities in the ontology, not a transient chat session.

### Routines — what should happen

The execution layer: rules, policies, workflows, collections, reactions, and automations.
Routines continuously assess the current world, create or advance threads, wait for input, invoke
integrations, update facts, escalate, retry, and react when dependencies change.

### Events — what happened

The causal record: facts asserted, inputs submitted, tasks completed, routines evaluated,
integrations received, decisions made, and actions attempted. Auditability, provenance, replay,
time travel, and triggers derive from this append-only history.

### Config — how the world is defined

The versioned definition of the runtime: types, attributes, relationships, rules, routines,
forms, permissions, integrations, and interfaces. Configuration can be branched, diffed, tested,
released, migrated, and traced to every behavior it produced.

Everything else—onboarding, I-9, E-Verify, background checks, policies, documents, approvals,
compliance, and integrations—is built from these primitives.

## Why Triplex is the right substrate

Triplex already provides most of the hard data and configuration foundations. Onboarded should be
built as a domain and execution layer over Triplex rather than as a second persistence model.

| Onboarded primitive | Triplex foundation                                                                                                                                           | Onboarded layer still required                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Ontology            | Temporal EAV facts, typed values, entity history and snapshots, Datalog, subscriptions, runtime `TypeExpr` schemas, and queryable validation observations    | Domain vocabularies, derived-fact conventions, authorization-aware access, and ergonomic entity APIs                                         |
| Threads             | Thread state, tasks, inputs, evidence, assignments, and comments can all be ordinary temporal entities and relationships                                     | Command invariants, lifecycle semantics, forms, deadlines, notification policy, permissions, and user-facing interaction APIs                |
| Routines            | Content-addressed rules, pure evaluation, verifiable decision proofs, dependency discovery, reactors, deploy-impact queries, and config refs                 | A durable scheduler and executor, wait states, retries, idempotency, concurrency control, integration dispatch, escalation, and compensation |
| Events              | Append-only assertions and retractions, transaction metadata, provenance, time travel, and immutable observations                                            | A first-class causal event envelope, command receipts, correlation and causation links, and transactional inbox/outbox semantics             |
| Config              | Typed content-addressed nodes, immutable `ConfigSnapshot` releases, structural sharing, refs, compatibility history, impact analysis, and proof verification | Config node families for threads, routines, forms, permissions, integrations, and UI; rollout and migration policy                           |

Triplex is therefore not the whole of Onboarded. It is the fact, query, history, validation,
content-addressing, and configuration kernel on which the operational system can be built.

## Runtime model

A typical operation should follow one causal path:

1. A human, agent, schedule, or integration submits a command.
2. The command boundary validates permissions, invariants, and its pinned `ConfigSnapshot`.
3. One Triplex transaction records the accepted facts, a causal event, and any required outbox
   work.
4. Subscriptions and dependency discovery identify affected routines without scanning the entire
   world.
5. A routine evaluates against an explicit configuration release and temporal fact view.
6. Its decision proof records what configuration and observations produced the decision.
7. The routine atomically advances a thread, writes facts, schedules a timer, or creates an
   integration command.
8. Workers perform external side effects idempotently and record their results as new events and
   facts.

```text
human / agent / timer / integration
                 |
              command
                 |
        transactional boundary
          /        |        \
       facts     event     outbox
          \        |        /
       dependency discovery
                 |
        routine + config pin
                 |
        decision proof / action
                 |
       thread, facts, or effect
```

The transaction is the consistency boundary. Datalog determines what is true and what may be
affected; it should not masquerade as the side-effect executor. Merkle identities and decision
proofs establish what was evaluated; database queries do not replace their verification.

## Modeling conventions

### Ontology facts

- Model business objects as stable entities with namespaced attributes.
- Represent relationships as `ref` values so Datalog can traverse them.
- Treat changes as new assertions and retractions rather than in-place mutation.
- Pin materializations and derived facts to their source transaction or observation time.
- Store provenance for derived facts: routine, routine revision, config snapshot, decision, and
  source observations.
- Use explicit cardinality. A routine must not silently choose among multiple live values.

### Threads

A thread should be a graph of ordinary entities rather than an opaque workflow blob. For example:

```text
thread
  :thread/kind          "collect-i9"
  :thread/subject       -> worker
  :thread/status        "waiting-for-input"
  :thread/config        -> ConfigSnapshot ContentId
  :thread/opened-by     -> causal event

task
  :task/thread          -> thread
  :task/assignee        -> person or agent
  :task/deadline        -> datetime
  :task/status          "open"

submission
  :submission/task      -> task
  :submission/evidence  -> document
  :submission/event     -> causal event
```

Lifecycle changes should be commands with invariants, not arbitrary fact writes. The facts remain
queryable; the command boundary ensures that impossible transitions are not accepted.

### Routines

Separate immutable definition from mutable execution:

- A routine definition is typed configuration included in a `ConfigSnapshot`.
- A routine run is a durable entity pinned to the exact definition and release it executed.
- A decision is a verifiable proof over the facts the routine observed.
- A step attempt records an idempotency key, lease, attempt number, and result.
- Waiting is durable state: a fact dependency, thread input, timer, or integration callback can
  resume the run.
- Reactors discover stale or affected work; workers execute it with bounded retries.

Exactly-once external side effects are not assumed. Onboarded should provide effectively-once
behavior through transactional outboxes, durable idempotency keys, and integration-specific
deduplication.

### Events

Triplex transaction history is the physical temporal record. Onboarded should add a semantic
causal envelope for operational behavior:

```text
event
  :event/kind           "task.completed"
  :event/subject        -> task
  :event/actor          -> person or agent
  :event/transaction    -> Triplex transaction
  :event/caused-by      -> prior event
  :event/correlation    -> thread or routine run
  :event/config         -> ConfigSnapshot ContentId
  :event/occurred-at    -> datetime
  :event/idempotency    "integration:provider:message-id"
```

Events explain why state changed. Facts describe the resulting world. Commands express requested
change. Keeping those roles distinct makes replay and audit comprehensible.

### Config

Every operational behavior should be attributable to an immutable config release. Moving `test`
or `live` changes what future work resolves, but an in-flight routine run remains pinned unless an
explicit migration moves it.

Config should eventually define:

- entity and attribute types;
- relationship and cardinality constraints;
- validation and eligibility rules;
- routine graphs and step contracts;
- thread, form, question, and evidence schemas;
- role and permission policies;
- integration capabilities and mappings;
- UI presentation hints; and
- migrations between released definitions.

Configuration is executable authority. Releases require compatibility checks, deploy-impact
analysis, tests, and an audit trail—not merely schema validation.

## Agents in the system

Agents supply intelligence; they do not bypass the operational model. An agent can inspect the
ontology, understand available primitives, propose or modify configuration, open threads,
complete authorized tasks, invoke declared capabilities, and leave structured state for the next
actor.

Agent actions should use the same commands, permissions, idempotency rules, event envelopes, and
configuration pins as human or deterministic automation. Natural-language reasoning may propose
an action; Onboarded decides whether and how that action becomes durable.

This avoids bespoke code for every customer workflow without turning unstructured agent output
into production state.

## HR ecosystem strategy

Onboarded is initially the coordination layer for the HR ecosystem. It connects systems companies
already use and automates the work between them: Workday, UKG, Salesforce, applicant-tracking
systems, payroll, background-check providers, government systems, and document platforms.

The durable value is not another system of record. It is the governed operational graph between
systems:

- normalize their claims into a shared ontology;
- identify missing, conflicting, or stale information;
- coordinate people and agents through threads;
- execute cross-system routines;
- retain proof of every decision and action; and
- evolve customer-specific behavior as versioned configuration.

As every HR system gains agents, those agents will still need a reliable way to act across system
and organizational boundaries. Onboarded is that operational layer. It does not need to build the
agent that wins; it makes every agent more capable.

## Delivery sequence

Triplex now supplies the first concurrency and provenance slice needed by this sequence:

- multi-operation KV and SQL transactions are atomic;
- compare-and-retract conditions protect config refs, validation heads, task claims, and leases;
- successful commands can record actor, command, correlation, causation, and config-snapshot pins;
- asserted and retracted changes are retained on queryable transaction entities; and
- every successful command receives an atomically committed position for ordered, resumable
  transaction-feed reads.

The smallest credible path from Triplex to Onboarded is:

1. Build command receipt, inbox, outbox, and consumer-checkpoint entities on Triplex's ordered
   causal transaction feed.
2. Build the minimal Thread model: task, assignment, question, submission, evidence, comment,
   deadline, and lifecycle commands.
3. Define routine configuration and durable routine-run state with idempotent step execution,
   timers, waits, retries, and leases.
4. Connect Triplex dependency discovery and reactors to routine invalidation and scheduling.
5. Add permission evaluation and pin every accepted command and routine run to a
   `ConfigSnapshot`.
6. Deliver one vertical onboarding flow that crosses all five primitives—for example, collect and
   validate worker identity evidence, request human correction, make a policy decision, call an
   integration, and retain a verifiable causal history.
7. Add configuration branching, simulation, deploy impact, migration, and staged rollout for that
   flow before generalizing the platform.

The next Triplex-level primitives are deliberately narrower than Onboarded's domain model:
temporal Datalog, declarative graph constraints, persisted materializations/reactors, a verified
content-addressed blob service, and config-driven migration planning. Threads, routine step
semantics, permissions, timers, and integrations remain Onboarded concepts built on those
primitives.

The vertical flow is the architecture test. It must demonstrate that Ontology, Threads, Routines,
Events, and Config are one coherent system rather than five adjacent subsystems.
