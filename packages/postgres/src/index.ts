/**
 * PostgreSQL backend package for effect-triples.
 *
 * Provides PostgreSQL-specific storage adapter, backend, and connection layer.
 */

export { PostgresqlDialect } from "./dialect.js";
export { makePostgresqlAdapter, PostgresqlAdapterLive } from "./PostgresqlAdapter.js";
export {
  makePostgresqlBackend,
  makePostgresqlBackendFromUrl,
  type PostgresqlBackendConfig,
} from "./PostgresqlBackend.js";
export {
  makePostgresqlLayer,
  makePostgresqlLayerFromUrl,
  PostgresqlLive,
  PostgresqlLiveFromUrl,
  type PostgresqlConfig,
} from "./PostgresqlLayer.js";
