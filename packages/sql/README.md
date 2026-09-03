# @bjacobso/triplex-sql

Shared SQL migrations, database management, and Datalog execution for Triplex. Most applications
install this transitively through a concrete backend package.

```bash
npm install effect @bjacobso/triplex @bjacobso/triplex-sql
```

The public surface includes the ordered greenfield `migrations`, explicit `runMigrations`, the
`SqlQueryExecutorLive` implementation of Triplex's internal query SPI, and SQL-backed
`DatabaseManager`/registry layers. It is infrastructure rather than a standalone database; use
`@bjacobso/triplex-sqlite` or `@bjacobso/triplex-postgres` for a concrete client and adapter.

The package is not yet published to npm.

MIT © 2026 Ben Jacobson.
