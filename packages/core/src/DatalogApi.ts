/**
 * Datalog API
 *
 * HTTP API endpoints for Datalog query execution.
 */

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
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
// Path Parameters
// =============================================================================

const databaseParam = HttpApiSchema.param("database", Schema.String);

// =============================================================================
// API Group
// =============================================================================

export class DatalogApi extends HttpApiGroup.make("datalog")
  .add(
    HttpApiEndpoint.post("query")`/db/${databaseParam}/datalog`
      .setPayload(DatalogQuery)
      .setUrlParams(
        Schema.Struct({
          debug: Schema.optional(Schema.BooleanFromString),
        }),
      )
      .addSuccess(DatalogQueryResponse)
      .addError(DatabaseNotFound)
      .addError(DatalogQueryError)
      .addError(AuthorizationDenied)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("queryWrapped")`/db/${databaseParam}/datalog/wrapped`
      .setPayload(WrappedQuery)
      .setUrlParams(
        Schema.Struct({
          debug: Schema.optional(Schema.BooleanFromString),
        }),
      )
      .addSuccess(WrappedQueryResponse)
      .addError(DatabaseNotFound)
      .addError(DatalogQueryError)
      .addError(AuthorizationDenied)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("explain")`/db/${databaseParam}/datalog/explain`
      .setPayload(DatalogQuery)
      .addSuccess(ExplainResult)
      .addError(DatabaseNotFound)
      .addError(DatalogQueryError)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("explainWrapped")`/db/${databaseParam}/datalog/explain/wrapped`
      .setPayload(WrappedQuery)
      .addSuccess(ExplainResult)
      .addError(DatabaseNotFound)
      .addError(DatalogQueryError)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("typeCheck")`/db/${databaseParam}/datalog/type-check`
      .setPayload(DatalogQuery)
      .addSuccess(TypeCheckResponse)
      .addError(DatabaseNotFound)
      .addError(DatalogQueryError)
      .addError(InternalError),
  ) {}
