/**
 * StoreCapability — composable triple store capability system.
 *
 * A capability is a function that takes a `TripleStoreService` and returns an
 * enhanced `TripleStoreService`. Each capability:
 *
 * 1. Wraps the inner store's methods to add behavior (before/after hooks)
 * 2. May require additional services via the Effect context
 * 3. Preserves the `TripleStoreService` interface for the next capability
 *
 * Capabilities are composed by sorting by priority (higher = outermost) and
 * folding over the base store. Dependencies are validated at composition time.
 *
 * @see specs/core/composable-store.md
 */

import { Data } from "effect";
import type { TripleStoreService } from "./TripleStore.js";

// =============================================================================
// Error
// =============================================================================

export class CapabilityError extends Data.TaggedError("CapabilityError")<{
  readonly message: string;
}> {}

// =============================================================================
// Capability Type
// =============================================================================

/**
 * A composable capability that decorates a TripleStoreService.
 *
 * The `wrap` function receives the inner store and returns an enhanced store.
 * Capabilities declare:
 * - `name`: unique identifier
 * - `priority`: ordering hint (higher = outermost in the decoration stack)
 * - `requires`: names of capabilities that must also be present
 * - `wrap`: the decorator function
 */
export interface StoreCapability {
  readonly name: string;
  readonly priority: number;
  readonly requires: ReadonlyArray<string>;
  readonly wrap: (inner: TripleStoreService) => TripleStoreService;
}

// =============================================================================
// Dependency Validation
// =============================================================================

/**
 * Validate that all capability dependencies are satisfied.
 * Throws CapabilityError if a required capability is missing.
 */
export const validateDependencies = (capabilities: readonly StoreCapability[]): void => {
  const provided = new Set(capabilities.map((c) => c.name));

  for (const cap of capabilities) {
    for (const req of cap.requires) {
      if (!provided.has(req)) {
        throw new CapabilityError({
          message: `Capability "${cap.name}" requires "${req}" but it is not in the composition`,
        });
      }
    }
  }

  // Check for duplicate names
  const seen = new Set<string>();
  for (const cap of capabilities) {
    if (seen.has(cap.name)) {
      throw new CapabilityError({
        message: `Duplicate capability name: "${cap.name}"`,
      });
    }
    seen.add(cap.name);
  }
};

// =============================================================================
// Composition
// =============================================================================

/**
 * Compose capabilities over a base TripleStoreService.
 *
 * Capabilities are sorted by priority (lowest = closest to base, highest = outermost).
 * This means capabilities with higher priority see the result of capabilities with
 * lower priority, and are the first to intercept operations from callers.
 *
 * Example ordering (outermost → innermost):
 *   Metrics (100) → RateLimiter (90) → AuditLog (80) → EntitySnapshots (60) → ChangeEmission (50) → Base (0)
 *
 * @param base - The base TripleStoreService (raw store without decorators)
 * @param capabilities - Capabilities to compose over the base
 * @returns The fully-composed TripleStoreService
 */
export const composeStore = (
  base: TripleStoreService,
  ...capabilities: StoreCapability[]
): TripleStoreService => {
  // Validate all dependency requirements
  validateDependencies(capabilities);

  // Sort by priority ascending (lowest first = closest to base)
  // We fold left, so the first capability wraps the base, the second wraps that, etc.
  // The highest-priority capability ends up outermost.
  const sorted = [...capabilities].sort((a, b) => a.priority - b.priority);

  // Fold capabilities over the base store
  return sorted.reduce<TripleStoreService>((inner, cap) => cap.wrap(inner), base);
};

// =============================================================================
// Describe
// =============================================================================

/**
 * Describe the active capability stack for diagnostics.
 * Returns capabilities in execution order (outermost first).
 */
export const describeCapabilities = (
  capabilities: readonly StoreCapability[],
): ReadonlyArray<{
  name: string;
  priority: number;
  requires: ReadonlyArray<string>;
}> => {
  return [...capabilities]
    .sort((a, b) => b.priority - a.priority) // outermost first for display
    .map((c) => ({
      name: c.name,
      priority: c.priority,
      requires: c.requires,
    }));
};
