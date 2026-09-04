# Triplex Dashboard

A standalone, browser-local explorer for Triplex. The dashboard uses Effect and
Foldkit end to end, with accessible controls from `@foldkit/ui` and Tailwind CSS.

```sh
pnpm dashboard
```

Open <http://localhost:4173>. The app starts a fresh in-memory Triplex database,
loads an optional students/courses/teachers demo fixture, and then reflects the
resulting database through six domain-independent views:

- overview and configured derivation candidates;
- entity-type discovery with temporal-basis-pinned, opaque-cursor tables whose columns
  are reflected from stored attributes, plus entity-scoped transaction timelines;
- generic form previews for configuration nodes that opt into `triplex.form/v1`;
- editable raw Datalog with query plans;
- the causal transaction journal;
- content-addressed releases, refs, logical config objects, immutable revision ancestry,
  dependency closures, and canonical stored bodies.

The entity workbench can create and edit typed facts as one attributed transaction.
The configuration workbench can create, edit, or remove top-level logical objects;
validate typed attributes and cross-object references; publish without changing an
environment; and explicitly promote or roll back `live` and `test` to any release.
Earlier revisions remain immutable and browseable. Nested children are preserved when
editing an object but are read-only in this dashboard. The demo database is
browser-local, so these writes reset when the runtime restarts.

The data path is real: Foldkit commands require `Triples` and `ConfigStore` from
an app-lifetime Effect layer. The dashboard renderer contains no knowledge of
students, quizzes, or grading. Its only form knowledge is the explicit, versioned
renderer contract; interpreting a submission and executing an application command
remain host responsibilities. The standalone layer composes the fixture from
`src/demo/learning.ts`; a host can provide any other Triplex database layer without
changing the inspector.
