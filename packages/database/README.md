# @open-ontology/database

Triple store, Datalog query engine, and storage adapters for Open Ontology.

**Independently consumable.** Zero `@open-ontology/*` dependencies. Only depends on `effect`, `@effect/platform`, and `ulidx`.

## What's inside

```
src/
├── Triple.ts, Value.ts, Branded.ts   Core data types (Triple, EntityId, TripleValue, etc.)
├── errors/                            Error types (WriteError, ReadError, DatalogError, etc.)
├── types/                             Query types (Pattern, Filter, QueryBuilder)
├── store/                             TripleStore service, DatabaseManager, capabilities
├── datalog/                           Datalog query engine — schema, compiler, SQL generation
├── storage/                           StorageAdapter interface (backend-agnostic)
├── kv/                                Hexastore indexes + in-memory KV backend
├── dialects/                          SQL dialects (SQLite, PostgreSQL)
├── utils/                             Transaction ID generation
└── params.ts                          SQL parameter collection
```

## Sub-packages

| Package                 | Purpose                   | Extra deps                |
| ----------------------- | ------------------------- | ------------------------- |
| `database/cloudflare`   | D1/Durable Object adapter | Cloudflare Workers types  |
| `database/postgres`     | PostgreSQL adapter        | `@effect/sql-pg`          |
| `database/foundationdb` | FoundationDB KV backend   | `foundationdb`            |
| `database/sqlite`       | SQLite adapter            | `@effect/sql-sqlite-node` |
| `database/testkit`      | Shared test helpers       | —                         |

## Key concepts

### Triple Store

All data is stored as triples: `(entityId, attribute, value)`.

```typescript
import { TripleStore } from "@open-ontology/database";

const store = yield * TripleStore;
yield *
  store.assert({
    entityId: "emp:alice",
    attribute: ":employee/name",
    value: { type: "string", value: "Alice" },
  });
```

### Datalog queries

JSON-based query language compiled to SQL:

```typescript
import { Datalog } from "@open-ontology/database";

const datalog = yield * Datalog;
const { results } =
  yield *
  datalog.queryValidated({
    find: ["?name", "?age"],
    where: [
      ["?person", ":person/name", "?name"],
      ["?person", ":person/age", "?age"],
      [">=", "?age", 18],
    ],
  });
```

### KV / Hexastore

In-memory ordered KV store with hexastore indexes for graph pattern matching. Used for testing and lightweight deployments:

```typescript
import { KvTripleStoreLive, KvDatalogLive, InMemoryKvBackendLive } from "@open-ontology/database";

const layer = KvTripleStoreLive.pipe(Layer.provide(InMemoryKvBackendLive));
```

### Injectable capabilities

`DatabaseManagerLayer` accepts runtime capabilities via `DatabaseCapabilities`. The database package provides change emission as a built-in capability. Heavier capabilities (reactive rules, processes, snapshots) are injected by the application layer:

```typescript
import { DatabaseCapabilities } from "@open-ontology/database";

const caps = Layer.succeed(DatabaseCapabilities, {
  factories: [myReactiveConstraintsFactory, mySnapshotFactory],
});
```

## Testing

```bash
pnpm test --filter @open-ontology/database
```

400 tests covering:

- KV backend, hexastore indexes, tuple encoding
- Datalog compilation, query execution, wrapper queries
- TripleStore and Datalog service layers
- SQL parameter collection and dialect handling
