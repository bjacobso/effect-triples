# Triplex agent exploration prompt

Explore Triplex from the perspective of an application-building agent.

Work in this repository, but do not modify committed source code, commit, or push. You may create a
narrowly scoped temporary seed script and a disposable SQLite database. Remove only the temporary
script when finished; retain the database long enough to report its path.

Start by reading completely:

- `AGENTS.md`
- `ARCHITECTURE.md`
- `README.md`
- `packages/cli/README.md`
- `docs/configuration.md`
- `docs/datalog.md`
- `docs/operational-primitives.md`

Inspect Git status before doing anything and preserve all existing worktree changes.

## Goal

Create a realistic disposable Triplex database, then discover and operate it primarily through the
`triplex` CLI as an autonomous agent would.

Use only documented public package exports. Never import `@bjacobso/triplex/internal` or access
SQLite tables directly.

## Setup

1. Run `pnpm install`.
2. Run `pnpm --filter @bjacobso/triplex-cli build`.
3. Create a temporary directory with `mktemp -d`.
4. Store the database at an explicit path such as `<temporary-directory>/learning.db`.
5. Record the absolute database path in your final report.

## CLI discovery

Run:

```sh
pnpm --silent triplex --sqlite <database> describe
pnpm --silent triplex --sqlite <database> --help
pnpm --silent triplex --sqlite <database> status
```

Treat the JSON returned by `describe` as the CLI capability contract.

## Seed a small domain

Create a temporary TypeScript seed script at:

```text
.scratch/triplex-agent-exploration/seed.ts
```

Use:

- `SqliteTriples.layer({ filename })`
- `ConfigStore.layer`
- public `ConfigNode`, `TypeExpr`, `Attribute`, and `EntityType` APIs
- Effect and Layer composition

Model a small learning domain:

- students
- teachers
- courses
- enrollments
- quizzes
- quiz submissions

Publish two configuration releases:

1. `learning-beta`, referenced by `test`
2. `learning-live`, referenced by `live`

Include at least:

- independently identified attribute definitions
- entity-type definitions
- a form configuration
- a policy configuration
- one changed logical object between releases
- one unchanged object reused across releases

Transact operational facts with the live release's snapshot ID in `meta.configSnapshot`.

Every transaction must include:

- `actor`
- unique `commandId`
- `correlationId`
- `configSnapshot`

Run the seed script through Effect. Do not write directly to SQLite.

## Explore the resulting database

Use only CLI commands for the remainder of the exercise.

Inspect entity structure:

```sh
pnpm --silent triplex --sqlite <database> entity types
pnpm --silent triplex --sqlite <database> entity list --type Student --limit 2
pnpm --silent triplex --sqlite <database> entity get <student-id>
pnpm --silent triplex --sqlite <database> entity facts <student-id>
```

Exercise entity pagination using `nextAfter`.

Inspect configuration:

```sh
pnpm --silent triplex --sqlite <database> config refs
pnpm --silent triplex --sqlite <database> config releases
pnpm --silent triplex --sqlite <database> config release --ref live
pnpm --silent triplex --sqlite <database> config release --ref test
pnpm --silent triplex --sqlite <database> config objects
pnpm --silent triplex --sqlite <database> config objects --kind form
pnpm --silent triplex --sqlite <database> config object form <form-key>
pnpm --silent triplex --sqlite <database> config impact attribute <attribute-key>
```

Confirm that the changed object has two immutable revisions with parent ancestry and that unchanged
objects reuse their revision IDs.

## Run Datalog

Create JSON queries that demonstrate:

1. Students and their names.
2. Students enrolled in a course, joining enrollment, student, and course facts.
3. Submitted quizzes that do not yet have a grade.
4. Ordered, cursor-paginated results using `query page`.

Run and explain them:

```sh
pnpm --silent triplex --sqlite <database> query explain --input <query-file>
pnpm --silent triplex --sqlite <database> query run --input <query-file> --debug
pnpm --silent triplex --sqlite <database> query page --input <wrapped-query-file>
```

## Exercise writes through the CLI

Use `transaction apply --input -` to:

1. Add another student.
2. Record a quiz submission.
3. Retract or correct one fact in an attributed transaction.

Use branded-compatible IDs and typed values. Do not omit `meta.actor` or `meta.commandId`.

Retry one already committed command ID and confirm it fails safely rather than applying twice.

## Inspect audit history

Run:

```sh
pnpm --silent triplex --sqlite <database> journal list --limit 10
pnpm --silent triplex --sqlite <database> journal receipt <command-id>
pnpm --silent triplex --sqlite <database> entity history <entity-id> --limit 2
```

If `entity history` returns `snapshotPosition` and `nextBeforePosition`, use both to fetch the next
stable page.

## Bitemporal exercise

Create a historical correction:

- assert an original value with a past `validFrom`
- later retract it and assert its replacement
- query the entity at current valid/recorded time
- query what was valid in the past as currently known
- query what was valid in the past before the correction was recorded

Use `--valid-at` and `--recorded-at`. Explain the difference in your report.

## Validation

Run:

```sh
pnpm --filter @bjacobso/triplex-cli test
pnpm --filter @bjacobso/triplex-cli typecheck
git diff --check
git status --short
```

Remove the temporary seed script through a precise patch deletion. Do not delete or modify the
temporary database until the exercise is reported.

## Final report

Provide:

- temporary database path
- configuration releases and refs created
- entity types and relationships discovered
- Datalog queries executed and what they proved
- bitemporal correction results
- transaction and command receipt inspected
- exact CLI commands that were most useful
- any CLI friction, missing primitives, inefficient scans, unclear errors, or commands an
  autonomous agent would still need
- confirmation that no tracked repository files were changed
