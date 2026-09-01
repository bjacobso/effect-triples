# config-graph

Content-addressed versioning for the configuration graph: forms, policies,
automations and the entities/attributes they all depend on, versioned as one
object rather than four unconnected version systems.

Nothing in the main app imports this yet. It is a hacking surface for the
model - `ConfigStore` is an in-memory reference implementation of the semantics
the Postgres tables would need, so the design can be exercised before any
migration is written.

| Module            | What it does                                                       |
| ----------------- | ------------------------------------------------------------------ |
| `CanonicalJson`   | Deterministic encoding. The substrate every hash is computed over. |
| `ContentId`       | `sha256-<hex>`, domain-separated.                                  |
| `SchemaId`        | Content-addresses an Effect Schema via its JSON Schema projection. |
| `ConfigNode`      | The merkle node: `cid`, `closureId`, `stamp`, `diff`.              |
| `TypeExpr`        | Types as data: a closed algebra with its own content id.           |
| `TypeSubsumption` | Whether values of one type stay valid under another. Total.        |
| `TypeSchema`      | Compiles a `TypeExpr` down to an Effect Schema.                    |
| `Entity`          | Declarative projectors: kinds, keys, `children` vs `ref` fields.   |
| `ConfigStore`     | Object store, revision log, snapshots, and git-style refs.         |
| `World`           | Facts, plus the clock as an explicit declared input.               |
| `BoolExpr`        | A bounded three-valued predicate language.                         |
| `Catalog`         | Rules as config nodes - the join between the two halves.           |
| `Evaluate`        | Evaluation, provenance, the closure-keyed cache, deploy impact.    |

An instance is not bound to the type that wrote it. `StoredObject.validUnder`
records every shape a body is known to satisfy, extended for free whenever
`TypeSubsumption.subsumes` proves a new shape accepts an old one, so deploying
a projection that merely adds an optional field mints no revisions at all.
`ConfigStore.recheck` asks the deploy-gate question: would every stored body of
this kind still parse under a proposed type?

Evaluation is addressed on both sides. A rule is an ordinary `ConfigNode`, so a
decision records the facts it read, the clock bucket it read them at, and the
content id of every rule it resolved - one closure, one cache, one invalidation
path. `Evaluate.impact` uses that closure as an index to answer "if I publish
this, who flips?" without evaluating subjects that cannot.

A decision is also a proof. Its id covers the answer, the rule version that
produced it, the digest of every input, and its children's ids, so
`Evaluate.verify` recomputes the whole tree from its own contents - no
database, no catalog, no trust in whoever handed it over. Values are observed
by digest rather than in the clear, so the record an auditor receives is not a
second copy of the data it was made from; `World.matches` lets someone holding
a candidate value prove it was the one used.

```sh
pnpm bench:typecheck   # the compile budget gate
```

Projectors are declared as entities rather than written by hand. Kinds are
declared up front as tokens, so relations can be circular (a form scopes an
automation whose action creates a task from that form) and keys are branded per
kind, so an attribute key and a form key are not interchangeable. `Entity` is
sugar over `ConfigNode.makeTyped` and provably produces identical ids.

```ts
const FormKind = Entity.kind("form");
const AttributeKind = Entity.kind("attribute");

const FormField = Entity.make({
  kind: Entity.kind("form.field"),
  attrs: FieldAttrs,
  key: (a) => a.path,
  refs: { uses_attribute: Entity.ref(AttributeKind) },
});
```

`src/ConfigGraph.e2e.test.ts` walks a realistic account config through five
releases and is the intended entry point for reading this.

```sh
pnpm test
```

`Reactor` closes the loop in the other direction. Registrations are indexed by
what their answers observed, so a submitted value, a republished rule and the
day turning are all one lookup - and a decision that depended on a fact being
_absent_ is found when that fact appears, which an index over existing rows
could not do. Recomputing and flipping are reported separately, because a rule
edit can invalidate a thousand decisions and change none of them.

## The explorer

A single page that runs the whole thing in a browser - the release, the
lifecycle step by step, the provenance tree with a working verify/tamper
button, and a publish with impact preview. Nothing is recorded: every id on the
page is computed live, which is only possible because `ContentId` uses a
hand-written SHA-256 rather than `node:crypto`. The page is the proof that the
kernel is genuinely browser-safe.

```sh
pnpm explorer
open explorer/index.html
```

The build step also runs `explorer/smoke.mjs`, which executes the page against
a minimal DOM shim and walks the same path a person would. It catches the class
of bug the test suite cannot see - a missing element id, a handler that throws -
because those only appear when the module runs against a document.
