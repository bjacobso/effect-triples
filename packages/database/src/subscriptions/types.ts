/**
 * Subscription Manager Types
 *
 * Shared types for the subscription invalidation system.
 */

import type { DatalogQuery } from "../Datalog.js";

// =============================================================================
// Query Dependencies
// =============================================================================

/**
 * Dependencies extracted from a Datalog query.
 * Used to determine if a change event might affect query results.
 */
export interface QueryDependencies {
  /**
   * Attributes the query reads.
   * e.g., {":employee/name", ":employee/department"}
   */
  readonly attributes: ReadonlySet<string>;

  /**
   * Entity types derived from attributes.
   * e.g., {"employee", "department"}
   */
  readonly entityTypes: ReadonlySet<string>;

  /**
   * Specific entity IDs if the query has constant entity bindings.
   * Empty if query uses only variables for entities.
   * e.g., {"emp:alice"} if query has ["emp:alice", ":employee/name", "?name"]
   */
  readonly boundEntityIds: ReadonlySet<string>;

  /**
   * Entity types that have at least one bound entity ID.
   * Used for Level 3 filtering: only apply entity ID filtering for changes
   * to entity types that actually have bound IDs.
   * e.g., {"employee"} if query binds "emp:alice" but uses variable for department
   */
  readonly boundEntityTypes: ReadonlySet<string>;

  /**
   * Link/relationship types the query traverses.
   * e.g., {"manages", "reports-to"}
   */
  readonly linkTypes: ReadonlySet<string>;

  /**
   * Rule names the query invokes (for recursive queries).
   * e.g., {"ancestor", "connected"}
   */
  readonly ruleNames: ReadonlySet<string>;
}

// =============================================================================
// Change Events
// =============================================================================

/**
 * A single triple change (from ChangeEmitter).
 * Matches the structure from PR #395.
 */
export interface TripleChange {
  readonly operation: "assert" | "retract";
  readonly entityId: string;
  readonly attribute: string;
}

// =============================================================================
// Invalidation Results
// =============================================================================

/**
 * Result of checking if a subscription is affected by changes.
 */
export interface InvalidationResult {
  /** Whether the subscription might be affected */
  readonly affected: boolean;
  /** Which specific changes caused the match (for debugging) */
  readonly matchingChanges: readonly TripleChange[];
  /** Reason for the decision (for debugging) */
  readonly reason: string;
}

// =============================================================================
// Subscription
// =============================================================================

/**
 * A registered subscription with its extracted dependencies.
 */
export interface Subscription {
  /** Unique identifier for this subscription */
  readonly id: string;
  /** The Datalog query being watched */
  readonly query: DatalogQuery;
  /** Dependencies extracted from the query */
  readonly dependencies: QueryDependencies;
  /** Hash of the query for deduplication and fast lookup */
  readonly queryHash: number;
  /** Optional: client/connection identifier for routing updates */
  readonly clientId?: string | undefined;
  /** Optional: hash of last result for change detection */
  readonly lastResultHash?: string | undefined;
}

// =============================================================================
// Affected Subscriptions
// =============================================================================

/**
 * Result of checking which subscriptions are affected by a batch of changes.
 */
export interface AffectedSubscriptions {
  /** Subscriptions that need to refresh */
  readonly affected: readonly Subscription[];
  /** Subscriptions that are not affected */
  readonly unaffected: readonly Subscription[];
  /** Detailed results per subscription (for debugging) */
  readonly details: ReadonlyMap<string, InvalidationResult>;
}
