# @bjacobso/triplex-sqlite

The Node.js SQLite backend for Triplex, built on `@effect/sql-sqlite-node`.

```bash
npm install effect @bjacobso/triplex @bjacobso/triplex-sqlite
```

Requires Node.js 22 or newer.

```ts
import { SqliteTriples } from "@bjacobso/triplex-sqlite";

const TriplesLive = SqliteTriples.layer({ filename: "app.db" });
// For tests: SqliteTriples.layerMemory
```

The convenience layer applies Triplex's single v1 migration. Production hosts that own DDL can
compose `makeSqliteLayerUnmigrated` and `makeSqliteAdapter({ autoMigrate: false })` with the shared
`migrations`/`runMigrations` exports from `@bjacobso/triplex-sql`.

SQLite is part of the default shared conformance suite. The package is not yet published to npm.

MIT © 2026 Ben Jacobson.
