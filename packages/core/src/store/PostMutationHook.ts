/**
 * PostMutationHook — abstract interface for reacting to storage-layer mutations.
 *
 * Called after every successful write operation (assert, retract, transact)
 * by the Triples change-emission capability. Implementations can trigger
 * downstream logic such as reactive rule evaluation.
 *
 * Hooks are fire-and-forget: failures must never break the underlying mutation.
 */

import { Context, Effect, Layer } from "effect";
import type { ChangeEvent } from "./ChangeEmitter.js";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Service for reacting to triple store mutations.
 *
 * Implementations should be non-blocking and failure-tolerant:
 * errors in the hook must never propagate to the caller.
 */
export interface PostMutationHookService {
  readonly onMutation: (event: ChangeEvent) => Effect.Effect<void>;
}

export class PostMutationHook extends Context.Service<PostMutationHook, PostMutationHookService>()(
  "PostMutationHook",
) {}

// =============================================================================
// No-op Implementation
// =============================================================================

/**
 * No-op hook for testing and scenarios where reactive evaluation is not needed.
 * Silently discards all events.
 */
export const NoopPostMutationHook: PostMutationHookService = {
  onMutation: () => Effect.void,
};

/**
 * Layer that provides the no-op PostMutationHook.
 */
export const NoopPostMutationHookLive = Layer.succeed(PostMutationHook, NoopPostMutationHook);
