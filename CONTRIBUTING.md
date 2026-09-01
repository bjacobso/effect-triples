# Contributing

Triplex uses Node.js 22 or newer and pnpm 10.11.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

`pnpm check` runs formatting, linting, typechecking, unit tests, SQLite integration tests,
and package builds. The stress suite is intentionally opt-in:

```bash
pnpm --filter triplex-stress stress-test
```

PostgreSQL and FoundationDB integrations need external services or native libraries and are
also opt-in:

```bash
pnpm test:postgres:integration
pnpm test:foundationdb:integration
```

All packages are ESM-only. Public exports must point to generated files under `dist`, and every
package change must continue to pass `pnpm pack:check` so source files, tests, caches, and local
dependencies never leak into npm tarballs.
