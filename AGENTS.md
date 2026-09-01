# Agent Guidelines

Triplex is a standalone, pre-1.0 package family built with Effect, TypeScript, pnpm, and
Turbo.

- Preserve the one-way package graph documented in `ARCHITECTURE.md`.
- Use Effect services and layers for effectful operations.
- Do not add compatibility imports or re-exports for `@open-ontology/*`.
- Public package exports must resolve only to built files in `dist`.
- Run `pnpm check` and `pnpm pack:check` before handing off changes.
- PostgreSQL, FoundationDB, and stress tests are opt-in unless a task specifically targets them.
