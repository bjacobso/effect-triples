/**
 * Transitional PostgreSQL backend package.
 *
 * This package is the public database-layer entrypoint for PostgreSQL-specific
 * wiring while extraction continues out of @open-ontology/core.
 */

export { PostgresqlDialect } from "./dialect.js";
export {
  makePostgresqlAdapter,
  PostgresqlAdapterLive,
} from "../../../core/src/storage/postgres/index.js";
export {
  makePostgresqlBackend,
  makePostgresqlBackendFromUrl,
  type PostgresqlBackendConfig,
} from "../../../core/src/storage/postgres/index.js";
export {
  makePostgresqlLayer,
  makePostgresqlLayerFromUrl,
  PostgresqlLive,
  PostgresqlLiveFromUrl,
  type PostgresqlConfig,
} from "../../../core/src/storage/postgres/index.js";
