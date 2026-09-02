/**
 * PostgreSQL backend package for @bjacobso/triplex.
 *
 * Provides PostgreSQL-specific storage adapter, backend, and connection layer.
 */

export { PostgresqlDialect } from "./dialect.js";
export {
  makePostgresqlAdapter,
  PostgresqlAdapterLive,
  PostgresqlAdapterUnmigrated,
  type PostgresqlAdapterConfig,
} from "./PostgresqlAdapter.js";
export {
  makePostgresqlBackend,
  makePostgresqlBackendFromUrl,
  databaseToSchema,
  type PostgresqlBackendConfig,
} from "./PostgresqlBackend.js";
export {
  makePostgresqlLayer,
  makePostgresqlLayerFromUrl,
  makePostgresqlLayerUnmigrated,
  makePostgresqlLayerUnmigratedFromUrl,
  PostgresqlLive,
  PostgresqlLiveFromUrl,
  type PostgresqlConfig,
} from "./PostgresqlLayer.js";
export { PgTriples, type PgTriplesLayer } from "./PgTriples.js";
