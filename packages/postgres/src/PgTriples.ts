/**
 * One-line PostgreSQL-backed `Triples` layers.
 *
 * ```ts
 * program.pipe(Effect.provide(PgTriples.layer({ database: "app" })))
 * program.pipe(Effect.provide(PgTriples.layerFromUrl(process.env.DATABASE_URL!)))
 * ```
 *
 * Each call constructs a fresh connection pool — create the layer once and
 * share it rather than rebuilding it per request.
 */

import { Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import {
  TriplesLive,
  CurrentDialect,
  TripleStoreRuntimeLayer,
  RuntimeServicesLive,
} from "@bjacobso/triplex";
import { SqlQueryExecutorLive } from "@bjacobso/triplex-sql";
import { PostgresqlAdapterLive } from "./PostgresqlAdapter.js";
import { PostgresqlDialect } from "./dialect.js";
import {
  makePostgresqlLayer,
  makePostgresqlLayerFromUrl,
  type PostgresqlConfig,
} from "./PostgresqlLayer.js";

const dialectLayer = Layer.succeed(CurrentDialect, PostgresqlDialect);

/** Build a `Triples` layer from a `SqlClient` layer (migrations already tapped in). */
const make = <E, R>(clientLayer: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  TriplesLive.pipe(
    Layer.provideMerge(SqlQueryExecutorLive),
    Layer.provideMerge(PostgresqlAdapterLive),
    Layer.provideMerge(dialectLayer),
    Layer.provideMerge(clientLayer),
    Layer.provide(TripleStoreRuntimeLayer),
    Layer.provideMerge(RuntimeServicesLive),
  );

export const PgTriples = {
  /** `Triples` over a pooled PostgreSQL connection (migrations applied). */
  layer: (config: PostgresqlConfig) => make(makePostgresqlLayer(config)),

  /** `Triples` from a connection URL, e.g. `postgresql://user:pw@host:5432/db`. */
  layerFromUrl: (url: string) => make(makePostgresqlLayerFromUrl(url)),
} as const;

export type PgTriplesLayer = ReturnType<typeof PgTriples.layer>;
