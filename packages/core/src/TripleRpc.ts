/**
 * Triple RPC
 *
 * Protocol-agnostic operations for triple management.
 * Used by both HTTP handlers and CLI commands.
 */

import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import {
  AssertTripleRequest,
  QueryRequest,
  RetractResponse,
  Triple,
  TransactOp,
  TransactResponse,
} from "./Triple.js";
import { DatabaseNotFound, TripleNotFound, InternalError } from "./Error.js";

// =============================================================================
// Triple RPC Group
// =============================================================================

/**
 * RPC operations for triple management.
 *
 * These operations mirror the TripleApi HTTP endpoints but are
 * protocol-agnostic, allowing them to be used over HTTP, WebSocket,
 * or directly in-process (e.g., from CLI).
 */
export class TripleRpc extends RpcGroup.make(
  /**
   * Assert one or more triples
   */
  Rpc.make("triple.assert", {
    payload: Schema.Struct({
      database: Schema.String,
      triples: AssertTripleRequest,
    }),
    success: Schema.Union(Triple, Schema.Array(Triple)),
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),

  /**
   * Retract a triple by ID
   */
  Rpc.make("triple.retract", {
    payload: Schema.Struct({
      database: Schema.String,
      tripleId: Schema.String,
    }),
    success: Schema.Void,
    error: Schema.Union(DatabaseNotFound, TripleNotFound, InternalError),
  }),

  /**
   * Retract triples matching a pattern
   */
  Rpc.make("triple.retractByPattern", {
    payload: Schema.Struct({
      database: Schema.String,
      pattern: QueryRequest,
    }),
    success: RetractResponse,
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),

  /**
   * Get a single triple by ID
   */
  Rpc.make("triple.get", {
    payload: Schema.Struct({
      database: Schema.String,
      tripleId: Schema.String,
    }),
    success: Triple,
    error: Schema.Union(DatabaseNotFound, TripleNotFound, InternalError),
  }),

  /**
   * Get all triples for an entity
   */
  Rpc.make("triple.getEntity", {
    payload: Schema.Struct({
      database: Schema.String,
      entityId: Schema.String,
    }),
    success: Schema.Array(Triple),
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),

  /**
   * Query triples by pattern
   */
  Rpc.make("triple.query", {
    payload: Schema.Struct({
      database: Schema.String,
      pattern: QueryRequest,
    }),
    success: Schema.Array(Triple),
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),

  /**
   * Query triples as of a specific timestamp (time travel)
   */
  Rpc.make("triple.queryAsOf", {
    payload: Schema.Struct({
      database: Schema.String,
      pattern: QueryRequest,
      asOf: Schema.Number,
    }),
    success: Schema.Array(Triple),
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),

  /**
   * Get history of all triples for an entity
   */
  Rpc.make("triple.history", {
    payload: Schema.Struct({
      database: Schema.String,
      entityId: Schema.String,
    }),
    success: Schema.Array(Triple),
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),

  /**
   * Execute a transaction with multiple operations atomically
   */
  Rpc.make("triple.transact", {
    payload: Schema.Struct({
      database: Schema.String,
      operations: Schema.Array(TransactOp),
      meta: Schema.optional(
        Schema.Struct({
          user: Schema.optional(Schema.String),
        }),
      ),
    }),
    success: TransactResponse,
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),
) {}
