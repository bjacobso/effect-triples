/**
 * Transitional SQLite backend package.
 *
 * This package is the public database-layer entrypoint for SQLite-specific
 * wiring while extraction continues out of @open-ontology/core.
 */

export { SqliteDialect } from "./dialect.js";
export {
  makeSqliteAdapter,
  SqliteAdapterLive,
  type SqliteAdapterConfig,
} from "../../../core/src/storage/sqlite/index.js";
export {
  makeSqliteBackend,
  SqliteBackendLive,
  type SqliteBackendConfig,
} from "../../../core/src/storage/sqlite/index.js";
export {
  makeSqliteLayer,
  SqliteTestLayer,
  SqliteLive,
} from "../../../core/src/storage/sqlite/index.js";
