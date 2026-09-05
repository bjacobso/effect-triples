# Workbench

A workforce operations app over Triplex: spreadsheet views, linked objects, and explainable decisions.

```sh
pnpm install
pnpm --filter @bjacobso/triplex build
pnpm workbench
```

Open <http://localhost:4174>. The app seeds 12 workers, three organizations, and seven tasks in a
browser-local in-memory Triplex database. Reloading starts a fresh demo.

- Search, filter, sort, export CSV, and switch between table, I-9 board, and employer graph views.
- Click an eligibility cell to inspect source checks, the pinned rule definition, facts, and history.
- Click a state, employment status, or I-9 cell to preview an edit through `Derivation.Overlay`.
- Apply the preview as an attributed atomic transaction with a compare-and-retract precondition.
- Create a worker and explore linked organizations, tasks, the Datalog rule, and causal activity.

The app composes public `Triples` and `ConfigStore` services in one app-lifetime Effect layer.
Eligibility is a real Datalog derivation with source provenance and a committed config release.
For non-matches, the inspector shows the individual source checks; these are not a synthesized
negative derivation proof. Previewing does not mutate the source store. A stale edited source fact
causes the commit to fail atomically.

Workbench is a private application package above core. The existing domain-independent dashboard
remains available through `pnpm dashboard`. Workbench currently uses a fixed workforce model;
it does not yet offer arbitrary ontology authoring, durable storage, authentication, collaborative
editing, or automatic task reconciliation. Demo tasks are independent stored objects, so completing
an I-9 changes eligibility but does not automatically close its linked tasks.

```sh
pnpm --filter @bjacobso/triplex-workbench test
pnpm --filter @bjacobso/triplex-workbench typecheck
pnpm --filter @bjacobso/triplex-workbench build
```
