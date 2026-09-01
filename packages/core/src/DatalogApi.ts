/**
 * Datalog API
 *
 * HTTP API endpoints for Datalog query execution.
 */

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  AuthorizationDenied,
  DatabaseNotFound,
  DatalogQueryError,
  InternalError,
} from "./Error.js";
import {
  DatalogQuery,
  DatalogQueryResponse,
  ExplainResult,
  TypeCheckResponse,
  WrappedQuery,
  WrappedQueryResponse,
} from "./Datalog.js";

// =============================================================================
// API Group
// =============================================================================

export class DatalogApi extends HttpApiGroup.make("datalog")
  .add(
    HttpApiEndpoint.post("query", "/db/:database/datalog", {
      params: { database: Schema.String },
      query: { debug: Schema.optional(Schema.Boolean) },
      payload: DatalogQuery,
      success: DatalogQueryResponse,
      error: [DatabaseNotFound, DatalogQueryError, AuthorizationDenied, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("queryPage", "/db/:database/datalog/page", {
      params: { database: Schema.String },
      query: { debug: Schema.optional(Schema.Boolean) },
      payload: WrappedQuery,
      success: WrappedQueryResponse,
      error: [DatabaseNotFound, DatalogQueryError, AuthorizationDenied, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("explain", "/db/:database/datalog/explain", {
      params: { database: Schema.String },
      payload: DatalogQuery,
      success: ExplainResult,
      error: [DatabaseNotFound, DatalogQueryError, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("explainPage", "/db/:database/datalog/explain/page", {
      params: { database: Schema.String },
      payload: WrappedQuery,
      success: ExplainResult,
      error: [DatabaseNotFound, DatalogQueryError, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("typeCheck", "/db/:database/datalog/type-check", {
      params: { database: Schema.String },
      payload: DatalogQuery,
      success: TypeCheckResponse,
      error: [DatabaseNotFound, DatalogQueryError, InternalError],
    }),
  ) {}
