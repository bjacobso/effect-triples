/**
 * Snapshot API
 *
 * HTTP API endpoints for transaction history and entity snapshots.
 * Powers the /tx page in the web UI.
 */

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { DatabaseNotFound, InternalError } from "./Error.js";
import {
  TransactionListRequest,
  TransactionListResponse,
  TransactionDetailResponse,
  EntitySnapshotResponse,
  HashHistoryResponse,
} from "./Snapshot.js";

// =============================================================================
// Path Parameters
// =============================================================================

const databaseParam = HttpApiSchema.param("database", Schema.String);
const txIdParam = HttpApiSchema.param("txId", Schema.String);
const entityIdParam = HttpApiSchema.param("entityId", Schema.String);

// =============================================================================
// API Group
// =============================================================================

export class SnapshotApi extends HttpApiGroup.make("snapshots")
  .add(
    HttpApiEndpoint.post("listTransactions")`/db/${databaseParam}/transactions`
      .setPayload(TransactionListRequest)
      .addSuccess(TransactionListResponse)
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.get("getTransaction")`/db/${databaseParam}/transactions/${txIdParam}`
      .addSuccess(TransactionDetailResponse)
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.get("getEntitySnapshot")`/db/${databaseParam}/snapshots/${entityIdParam}`
      .addSuccess(Schema.NullOr(EntitySnapshotResponse))
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.get(
      "getEntityHashHistory",
    )`/db/${databaseParam}/snapshots/${entityIdParam}/history`
      .addSuccess(HashHistoryResponse)
      .addError(DatabaseNotFound)
      .addError(InternalError),
  ) {}
