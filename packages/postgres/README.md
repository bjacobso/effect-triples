# @bjacobso/triplex-postgres

The PostgreSQL backend for Triplex, built on `@effect/sql-pg`.

```bash
npm install effect @bjacobso/triplex @bjacobso/triplex-postgres
```

Requires Node.js 22 or newer and a PostgreSQL connection URL.

```ts
import { PgTriples } from "@bjacobso/triplex-postgres";

const TriplesLive = PgTriples.layerFromUrl(process.env.DATABASE_URL!);
```

For database-per-organization hosts, compose `DatabaseManagerLive` with the PostgreSQL
`StorageBackend`. Logical `DatabaseId` values map to deterministic, safely quoted schemas, and
every connection in a physical pool is bound to that schema. Unmigrated client/adapter layers are
available when the host owns DDL.

PostgreSQL passes the opt-in shared conformance and multi-connection isolation integration suite,
but that suite is not yet a required CI job. Treat this package as a production candidate rather
than a supported default. It is not yet published to npm.

MIT © 2026 Ben Jacobson.
