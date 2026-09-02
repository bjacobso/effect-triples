/**
 * Snapshot Module
 *
 * Schemas for entity snapshots and transaction history.
 */

import { Schema } from "effect";
import { ContentIdSchema } from "./content/ContentId.js";

// =============================================================================
// Transaction Summary (for listing)
// =============================================================================

/**
 * A single transaction summary — returned by the transaction list endpoint.
 */
export const TransactionSummary = Schema.Struct({
  /** Transaction entity ID (e.g., "_tx/01ARZ...") */
  txId: Schema.String,
  /** When the transaction occurred (epoch millis) */
  timestamp: Schema.Number,
  /** Actor that performed the transaction (if recorded) */
  actor: Schema.NullOr(Schema.String),
  /** Number of triples asserted in this transaction */
  assertCount: Schema.Number,
  /** Number of triples retracted in this transaction */
  retractCount: Schema.Number,
  /** Entity IDs affected by this transaction (deduplicated) */
  affectedEntities: Schema.Array(Schema.String),
});
export type TransactionSummary = typeof TransactionSummary.Type;

/**
 * Paginated list of transactions.
 */
export const TransactionListResponse = Schema.Struct({
  transactions: Schema.Array(TransactionSummary),
  /** Opaque cursor for the next page (null if no more results) */
  nextCursor: Schema.NullOr(Schema.String),
  /** Total number of transactions (only on first page) */
  totalCount: Schema.optional(Schema.Number),
});
export type TransactionListResponse = typeof TransactionListResponse.Type;

/**
 * Request for listing transactions (cursor-based pagination).
 */
export const TransactionListRequest = Schema.Struct({
  /** Max number of transactions to return per page */
  limit: Schema.optional(Schema.Number),
  /** Opaque cursor from a previous response */
  cursor: Schema.optional(Schema.String),
});
export type TransactionListRequest = typeof TransactionListRequest.Type;

// =============================================================================
// Snapshot Value (JSON-serializable attribute value)
// =============================================================================

/**
 * A single attribute value in a snapshot.
 */
export const SnapshotValueSchema = Schema.Struct({
  type: Schema.String,
  value: Schema.Unknown,
});
export type SnapshotValueSchema = typeof SnapshotValueSchema.Type;

// =============================================================================
// Entity Snapshot (full entity state at a point in time)
// =============================================================================

/**
 * Full entity snapshot — JSON attribute map + content hash.
 */
export const EntitySnapshotResponse = Schema.Struct({
  entityId: Schema.String,
  entityType: Schema.NullOr(Schema.String),
  /** Attribute map: attribute name → value or array of values */
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  /** Content-addressed hash (`sha256-<64 lowercase hex>`). */
  hash: ContentIdSchema,
  /** Transaction ID that produced this snapshot */
  txId: Schema.String,
  /** Transaction timestamp (epoch millis) */
  txTime: Schema.Number,
});
export type EntitySnapshotResponse = typeof EntitySnapshotResponse.Type;

// =============================================================================
// Entity Hash History
// =============================================================================

/**
 * A single entry in the entity's hash history.
 */
export const HashHistoryEntry = Schema.Struct({
  txId: Schema.String,
  txTime: Schema.Number,
  hash: ContentIdSchema,
});
export type HashHistoryEntry = typeof HashHistoryEntry.Type;

/**
 * Full hash history for an entity.
 */
export const HashHistoryResponse = Schema.Struct({
  entityId: Schema.String,
  history: Schema.Array(HashHistoryEntry),
});
export type HashHistoryResponse = typeof HashHistoryResponse.Type;

// =============================================================================
// Transaction Detail (entities affected + their snapshots)
// =============================================================================

/**
 * An entity's snapshot state within a transaction.
 */
export const TransactionEntitySnapshot = Schema.Struct({
  entityId: Schema.String,
  entityType: Schema.NullOr(Schema.String),
  /** Snapshot at this transaction (null if entity was fully retracted) */
  snapshot: Schema.NullOr(EntitySnapshotResponse),
  /** Previous hash (null if this is the first transaction for this entity) */
  previousHash: Schema.NullOr(ContentIdSchema),
});
export type TransactionEntitySnapshot = typeof TransactionEntitySnapshot.Type;

/**
 * Full transaction detail — the transaction plus snapshots for all affected entities.
 */
export const TransactionDetailResponse = Schema.Struct({
  txId: Schema.String,
  timestamp: Schema.Number,
  actor: Schema.NullOr(Schema.String),
  assertCount: Schema.Number,
  retractCount: Schema.Number,
  /** Snapshots for all entities affected by this transaction */
  entities: Schema.Array(TransactionEntitySnapshot),
});
export type TransactionDetailResponse = typeof TransactionDetailResponse.Type;
