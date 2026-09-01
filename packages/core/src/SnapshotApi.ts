/**
 * Snapshot API
 *
 * HTTP API endpoints for transaction history and entity snapshots.
 * Powers the /tx page in the web UI.
 */

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { DatabaseNotFound, InternalError } from "./Error.js";
import {
  TransactionListRequest,
  TransactionListResponse,
  TransactionDetailResponse,
  EntitySnapshotResponse,
  HashHistoryResponse,
} from "./Snapshot.js";

// =============================================================================
// API Group
// =============================================================================

export class SnapshotApi extends HttpApiGroup.make("snapshots")
  .add(
    HttpApiEndpoint.post("listTransactions", "/db/:database/transactions", {
      params: { database: Schema.String },
      payload: TransactionListRequest,
      success: TransactionListResponse,
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getTransaction", "/db/:database/transactions/:txId", {
      params: { database: Schema.String, txId: Schema.String },
      success: TransactionDetailResponse,
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getEntitySnapshot", "/db/:database/snapshots/:entityId", {
      params: { database: Schema.String, entityId: Schema.String },
      success: Schema.NullOr(EntitySnapshotResponse),
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getEntityHashHistory", "/db/:database/snapshots/:entityId/history", {
      params: { database: Schema.String, entityId: Schema.String },
      success: HashHistoryResponse,
      error: [DatabaseNotFound, InternalError],
    }),
  ) {}
