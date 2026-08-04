/**
 * Triple API
 *
 * HTTP API endpoints for triple operations (assert, retract, query).
 */

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { AuthorizationDenied, DatabaseNotFound, InternalError, TripleNotFound } from "./Error.js";
import {
  AssertTripleRequest,
  QueryRequest,
  QueryAsOfRequest,
  RetractResponse,
  TripleResponse,
  TransactRequest,
  TransactResponse,
} from "./Triple.js";

// =============================================================================
// Path Parameters
// =============================================================================

const databaseParam = HttpApiSchema.param("database", Schema.String);
const tripleIdParam = HttpApiSchema.param("id", Schema.String);
// Entity IDs should be URL-encoded by clients (e.g., employee:alice -> employee%3Aalice)
// The HTTP layer handles decoding automatically
const entityIdParam = HttpApiSchema.param("entityId", Schema.String);

// =============================================================================
// API Group
// =============================================================================

export class TripleApi extends HttpApiGroup.make("triples")
  .add(
    HttpApiEndpoint.post("assert")`/db/${databaseParam}/triples`
      .setPayload(AssertTripleRequest)
      .addSuccess(Schema.Union(TripleResponse, Schema.Array(TripleResponse)))
      .addError(DatabaseNotFound)
      .addError(AuthorizationDenied)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.del("retract")`/db/${databaseParam}/triples/${tripleIdParam}`
      .addError(DatabaseNotFound)
      .addError(TripleNotFound)
      .addError(AuthorizationDenied)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("retractByPattern")`/db/${databaseParam}/retract`
      .setPayload(QueryRequest)
      .addSuccess(RetractResponse)
      .addError(DatabaseNotFound)
      .addError(AuthorizationDenied)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.get("getTriple")`/db/${databaseParam}/triples/${tripleIdParam}`
      .addSuccess(TripleResponse)
      .addError(DatabaseNotFound)
      .addError(TripleNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.get("getEntity")`/db/${databaseParam}/entities/${entityIdParam}`
      .addSuccess(Schema.Array(TripleResponse))
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("query")`/db/${databaseParam}/query`
      .setPayload(QueryRequest)
      .addSuccess(Schema.Array(TripleResponse))
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("queryAsOf")`/db/${databaseParam}/query/as-of`
      .setPayload(QueryAsOfRequest)
      .addSuccess(Schema.Array(TripleResponse))
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.get("history")`/db/${databaseParam}/entities/${entityIdParam}/history`
      .addSuccess(Schema.Array(TripleResponse))
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("transact")`/db/${databaseParam}/transact`
      .setPayload(TransactRequest)
      .addSuccess(TransactResponse)
      .addError(DatabaseNotFound)
      .addError(AuthorizationDenied)
      .addError(TripleNotFound)
      .addError(InternalError),
  ) {}
