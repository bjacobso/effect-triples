/**
 * Triple API
 *
 * HTTP API endpoints for triple operations (assert, retract, query).
 */

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
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
// API Group
// =============================================================================

export class TripleApi extends HttpApiGroup.make("triples")
  .add(
    HttpApiEndpoint.post("assert", "/db/:database/triples", {
      params: { database: Schema.String },
      payload: AssertTripleRequest,
      success: Schema.Union([TripleResponse, Schema.Array(TripleResponse)]),
      error: [DatabaseNotFound, AuthorizationDenied, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("retract", "/db/:database/triples/:id", {
      params: { database: Schema.String, id: Schema.String },
      error: [DatabaseNotFound, TripleNotFound, AuthorizationDenied, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("retractByPattern", "/db/:database/retract", {
      params: { database: Schema.String },
      payload: QueryRequest,
      success: RetractResponse,
      error: [DatabaseNotFound, AuthorizationDenied, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getTriple", "/db/:database/triples/:id", {
      params: { database: Schema.String, id: Schema.String },
      success: TripleResponse,
      error: [DatabaseNotFound, TripleNotFound, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getEntity", "/db/:database/entities/:entityId", {
      params: { database: Schema.String, entityId: Schema.String },
      success: Schema.Array(TripleResponse),
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("query", "/db/:database/query", {
      params: { database: Schema.String },
      payload: QueryRequest,
      success: Schema.Array(TripleResponse),
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("queryAsOf", "/db/:database/query/as-of", {
      params: { database: Schema.String },
      payload: QueryAsOfRequest,
      success: Schema.Array(TripleResponse),
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("history", "/db/:database/entities/:entityId/history", {
      params: { database: Schema.String, entityId: Schema.String },
      success: Schema.Array(TripleResponse),
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("transact", "/db/:database/transact", {
      params: { database: Schema.String },
      payload: TransactRequest,
      success: TransactResponse,
      error: [DatabaseNotFound, AuthorizationDenied, TripleNotFound, InternalError],
    }),
  ) {}
