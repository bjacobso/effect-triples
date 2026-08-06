/**
 * ChangeEmitter — abstract interface for broadcasting storage-layer changes.
 *
 * The Triples capability calls `emit` after every write operation.
 * Concrete implementations (Cloudflare WebSocket broadcast, Node.js ws broadcast)
 * fan out the event to connected clients.
 */

import { Context, Effect, Layer } from "effect";

// =============================================================================
// Change Event Types
// =============================================================================

/**
 * A single triple change within a transaction.
 * Values are intentionally omitted to reduce bandwidth.
 */
export interface TripleChange {
  readonly operation: "assert" | "retract";
  readonly entityId: string;
  readonly attribute: string;
}

/**
 * A batch of changes emitted after a write operation.
 */
export interface ChangeEvent {
  /** Transaction ID from Triples (matches `txId` in TransactionResult) */
  readonly txId: string;
  /** Unix timestamp (milliseconds) */
  readonly timestamp: number;
  /** Individual triple changes in this transaction */
  readonly changes: readonly TripleChange[];
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Service for emitting change events from the storage layer.
 *
 * Implementations should be fire-and-forget: failures in emission
 * must never break the underlying mutation.
 */
export interface ChangeEmitterService {
  readonly emit: (event: ChangeEvent) => Effect.Effect<void>;
}

export class ChangeEmitter extends Context.Tag("ChangeEmitter")<
  ChangeEmitter,
  ChangeEmitterService
>() {}

// =============================================================================
// No-op Implementation
// =============================================================================

/**
 * No-op emitter for testing and non-realtime scenarios.
 * Silently discards all events.
 */
export const NoopChangeEmitter: ChangeEmitterService = {
  emit: () => Effect.void,
};

/**
 * Layer that provides the no-op ChangeEmitter.
 */
export const NoopChangeEmitterLive = Layer.succeed(ChangeEmitter, NoopChangeEmitter);
