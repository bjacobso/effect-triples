/**
 * Subscription Invalidation Check
 *
 * Pure function that determines if a subscription's dependencies
 * overlap with a batch of changes, using three-level filtering.
 */

import type { QueryDependencies, TripleChange, InvalidationResult } from "./types.js";
import { extractEntityType } from "./extract-dependencies.js";

/**
 * Check if a subscription with given dependencies is affected by a batch of changes.
 *
 * Uses three-level filtering:
 * 1. Entity Type — Does the change affect an entity type the query reads?
 * 2. Attribute — Does the change affect an attribute the query reads?
 * 3. Entity ID — If the query is scoped to specific entities, is this one of them?
 *
 * This is a conservative check: it may return true when the subscription
 * wouldn't actually change (false positive), but should never return false
 * when the subscription would change (no false negatives).
 *
 * @param deps Dependencies extracted from a subscription's query
 * @param changes Batch of triple changes to check
 * @returns Result indicating if the subscription is affected and why
 */
export function checkInvalidation(
  deps: QueryDependencies,
  changes: readonly TripleChange[],
): InvalidationResult {
  // Fast path: no changes means not affected
  if (changes.length === 0) {
    return {
      affected: false,
      matchingChanges: [],
      reason: "No changes provided",
    };
  }

  // Fast path: query reads nothing (degenerate case)
  if (deps.attributes.size === 0 && deps.entityTypes.size === 0) {
    if (deps.hasDynamicAttributes) {
      return {
        affected: true,
        matchingChanges: [...changes],
        reason: "Query reads dynamic attributes and cannot be narrowed statically",
      };
    }

    return {
      affected: false,
      matchingChanges: [],
      reason: "Query has no data dependencies",
    };
  }

  const matchingChanges: TripleChange[] = [];

  for (const change of changes) {
    // Level 1: Check entity type
    const changeEntityType = extractEntityType(change.attribute);
    if (changeEntityType !== null && deps.entityTypes.size > 0) {
      if (!deps.entityTypes.has(changeEntityType)) {
        // This change is for a different entity type, skip
        continue;
      }
    }

    // Level 2: Check attribute
    if (
      !deps.hasDynamicAttributes &&
      deps.attributes.size > 0 &&
      !deps.attributes.has(change.attribute)
    ) {
      // Query doesn't read this attribute, skip
      continue;
    }

    // Level 3: Check specific entity (if subscription is scoped for THIS entity type)
    // Only apply entity ID filtering if the change's entity type has bound IDs
    if (deps.boundEntityIds.size > 0 && changeEntityType !== null) {
      // Check if this entity type has any bound IDs
      if (deps.boundEntityTypes.has(changeEntityType)) {
        // This entity type is scoped - check if the specific entity is bound
        if (!deps.boundEntityIds.has(change.entityId)) {
          // Query only reads specific entities of this type, this isn't one, skip
          continue;
        }
      }
      // If the entity type doesn't have bound IDs, don't filter (all entities allowed)
    }

    // This change matches the subscription's dependencies
    matchingChanges.push(change);
  }

  if (matchingChanges.length === 0) {
    return {
      affected: false,
      matchingChanges: [],
      reason: "No changes overlap with query dependencies",
    };
  }

  return {
    affected: true,
    matchingChanges,
    reason: `${matchingChanges.length} change(s) affect attributes read by this query`,
  };
}

/**
 * Check if a single change affects a subscription's dependencies.
 *
 * Convenience wrapper around checkInvalidation for single-change scenarios.
 *
 * @param deps Dependencies extracted from a subscription's query
 * @param change Single triple change to check
 * @returns true if the subscription might be affected
 */
export function isAffectedByChange(deps: QueryDependencies, change: TripleChange): boolean {
  return checkInvalidation(deps, [change]).affected;
}
