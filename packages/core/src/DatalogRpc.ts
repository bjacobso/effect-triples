/**
 * Datalog RPC
 *
 * Protocol-agnostic operations for Datalog query execution.
 * Used by both HTTP handlers and CLI commands.
 */

import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Schema } from "effect";
import { DatalogQuery, DatalogQueryResponse } from "./Datalog.js";
import { DatabaseNotFound, DatalogQueryError, InternalError } from "./Error.js";

// =============================================================================
// Streaming Result Type
// =============================================================================

/**
 * Single result row for streaming queries
 */
export const DatalogResultRow = Schema.Record(Schema.String, Schema.Unknown);
export type DatalogResultRow = typeof DatalogResultRow.Type;

// =============================================================================
// Datalog RPC Group
// =============================================================================

/**
 * RPC operations for Datalog query execution.
 *
 * These operations mirror the DatalogApi HTTP endpoints but are
 * protocol-agnostic, allowing them to be used over HTTP, WebSocket,
 * or directly in-process (e.g., from CLI).
 */
export class DatalogRpc extends RpcGroup.make(
  /**
   * Execute a Datalog query and return all results
   */
  Rpc.make("datalog.query", {
    payload: Schema.Struct({
      database: Schema.String,
      query: DatalogQuery,
      debug: Schema.optional(Schema.Boolean),
    }),
    success: DatalogQueryResponse,
    error: Schema.Union([DatabaseNotFound, DatalogQueryError, InternalError]),
  }),

  /**
   * Execute a Datalog query and stream results row by row
   *
   * This is useful for large result sets where you want to:
   * - Start processing results before the query is complete
   * - Avoid memory pressure from loading all results at once
   * - Support cancellation mid-stream
   */
  Rpc.make("datalog.queryStream", {
    payload: Schema.Struct({
      database: Schema.String,
      query: DatalogQuery,
    }),
    success: DatalogResultRow,
    error: Schema.Union([DatabaseNotFound, DatalogQueryError, InternalError]),
    stream: true,
  }),
) {}
