/**
 * SQLite backend package for @open-ontology/database.
 *
 * Provides SQLite-specific storage adapter, backend, and connection layer.
 */

export { SqliteDialect } from "./dialect.js";
export { makeSqliteAdapter, SqliteAdapterLive, type SqliteAdapterConfig } from "./SqliteAdapter.js";
export { makeSqliteBackend, SqliteBackendLive, type SqliteBackendConfig } from "./SqliteBackend.js";
export { makeSqliteLayer, SqliteTestLayer, SqliteLive } from "./SqliteLayer.js";
