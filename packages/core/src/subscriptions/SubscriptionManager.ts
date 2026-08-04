/**
 * SubscriptionManager Service
 *
 * Manages registered subscriptions and provides efficient invalidation checks.
 * Pure in-memory implementation with no external dependencies.
 */

import { Context, Effect, Ref, HashMap, HashSet, Option, Layer } from "effect";
import type { DatalogQuery } from "../Datalog.js";
import { extractDependencies } from "./extract-dependencies.js";
import { checkInvalidation } from "./invalidation.js";
import { hashQuery } from "./query-hash.js";
import type {
  Subscription,
  TripleChange,
  AffectedSubscriptions,
  InvalidationResult,
} from "./types.js";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * SubscriptionManager service interface.
 *
 * Provides methods for registering subscriptions and checking which
 * subscriptions are affected by data changes.
 */
export interface SubscriptionManagerService {
  /**
   * Register a new subscription.
   * Dependencies are automatically extracted from the query.
   *
   * @param id Unique identifier for the subscription
   * @param query The Datalog query to watch
   * @param clientId Optional client/connection identifier for routing updates
   * @returns The registered subscription with extracted dependencies
   */
  readonly register: (
    id: string,
    query: DatalogQuery,
    clientId?: string,
  ) => Effect.Effect<Subscription>;

  /**
   * Unregister a subscription.
   *
   * @param id Subscription ID to remove
   */
  readonly unregister: (id: string) => Effect.Effect<void>;

  /**
   * Check which subscriptions are affected by a batch of changes.
   * This is the core invalidation primitive.
   *
   * @param changes Batch of triple changes to check
   * @returns Object containing affected and unaffected subscriptions
   */
  readonly checkAffected: (
    changes: readonly TripleChange[],
  ) => Effect.Effect<AffectedSubscriptions>;

  /**
   * Get all registered subscriptions (for debugging/admin).
   */
  readonly list: () => Effect.Effect<readonly Subscription[]>;

  /**
   * Get a specific subscription by ID.
   *
   * @param id Subscription ID to look up
   * @returns The subscription if found, undefined otherwise
   */
  readonly get: (id: string) => Effect.Effect<Subscription | undefined>;

  /**
   * Get the count of registered subscriptions.
   */
  readonly count: () => Effect.Effect<number>;

  /**
   * Clear all subscriptions (for testing).
   */
  readonly clear: () => Effect.Effect<void>;

  /**
   * Find all subscriptions with a given query hash.
   * Useful for deduplication and finding identical queries.
   *
   * @param queryHash The hash to look up
   * @returns Array of subscriptions with matching hash
   */
  readonly findByQueryHash: (queryHash: number) => Effect.Effect<readonly Subscription[]>;

  /**
   * Compute the hash for a Datalog query.
   * Exposed for external use (e.g., frontend reactivity keys).
   *
   * @param query The query to hash
   * @returns The query's hash value
   */
  readonly getQueryHash: (query: DatalogQuery) => number;
}

// =============================================================================
// Service Tag
// =============================================================================

export class SubscriptionManager extends Context.Tag("SubscriptionManager")<
  SubscriptionManager,
  SubscriptionManagerService
>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a SubscriptionManager service instance.
 *
 * This is a pure in-memory implementation using Effect's Ref for
 * thread-safe state management. It has no external dependencies
 * and can be used in any environment.
 */
export const makeSubscriptionManager = Effect.gen(function* () {
  // Store subscriptions in a Ref for thread-safe updates
  const subscriptionsRef = yield* Ref.make(HashMap.empty<string, Subscription>());

  // Index: query hash → set of subscription IDs
  // Enables O(1) lookup of subscriptions by query structure
  const byQueryHashRef = yield* Ref.make(HashMap.empty<number, HashSet.HashSet<string>>());

  const register: SubscriptionManagerService["register"] = (id, query, clientId) =>
    Effect.gen(function* () {
      const dependencies = extractDependencies(query);
      const qHash = hashQuery(query);

      // Check if we're replacing an existing subscription (need to clean up old hash index)
      const existing = yield* Ref.get(subscriptionsRef).pipe(
        Effect.map((subs) => Option.getOrUndefined(HashMap.get(subs, id))),
      );

      const subscription: Subscription = {
        id,
        query,
        dependencies,
        queryHash: qHash,
        clientId,
      };

      // Update main subscription store
      yield* Ref.update(subscriptionsRef, HashMap.set(id, subscription));

      // Update hash index
      yield* Ref.update(byQueryHashRef, (index) => {
        // Remove from old hash index if replacing
        let updated = index;
        if (existing && existing.queryHash !== qHash) {
          const oldIds = Option.getOrElse(HashMap.get(index, existing.queryHash), () =>
            HashSet.empty<string>(),
          );
          const newOldIds = HashSet.remove(oldIds, id);
          updated =
            HashSet.size(newOldIds) === 0
              ? HashMap.remove(updated, existing.queryHash)
              : HashMap.set(updated, existing.queryHash, newOldIds);
        }

        // Add to new hash index
        const ids = Option.getOrElse(HashMap.get(updated, qHash), () => HashSet.empty<string>());
        return HashMap.set(updated, qHash, HashSet.add(ids, id));
      });

      return subscription;
    });

  const unregister: SubscriptionManagerService["unregister"] = (id) =>
    Effect.gen(function* () {
      // Get the subscription to find its hash
      const existing = yield* Ref.get(subscriptionsRef).pipe(
        Effect.map((subs) => Option.getOrUndefined(HashMap.get(subs, id))),
      );

      // Remove from main store
      yield* Ref.update(subscriptionsRef, HashMap.remove(id));

      // Remove from hash index if it existed
      if (existing) {
        yield* Ref.update(byQueryHashRef, (index) => {
          const ids = Option.getOrElse(HashMap.get(index, existing.queryHash), () =>
            HashSet.empty<string>(),
          );
          const newIds = HashSet.remove(ids, id);
          return HashSet.size(newIds) === 0
            ? HashMap.remove(index, existing.queryHash)
            : HashMap.set(index, existing.queryHash, newIds);
        });
      }
    });

  const checkAffected: SubscriptionManagerService["checkAffected"] = (changes) =>
    Effect.gen(function* () {
      const subscriptions = yield* Ref.get(subscriptionsRef);

      const affected: Subscription[] = [];
      const unaffected: Subscription[] = [];
      const details = new Map<string, InvalidationResult>();

      for (const [_id, sub] of subscriptions) {
        const result = checkInvalidation(sub.dependencies, changes);
        details.set(sub.id, result);

        if (result.affected) {
          affected.push(sub);
        } else {
          unaffected.push(sub);
        }
      }

      return { affected, unaffected, details };
    });

  const list: SubscriptionManagerService["list"] = () =>
    Effect.gen(function* () {
      const subscriptions = yield* Ref.get(subscriptionsRef);
      return Array.from(HashMap.values(subscriptions));
    });

  const get: SubscriptionManagerService["get"] = (id) =>
    Effect.gen(function* () {
      const subscriptions = yield* Ref.get(subscriptionsRef);
      return Option.getOrUndefined(HashMap.get(subscriptions, id));
    });

  const count: SubscriptionManagerService["count"] = () =>
    Effect.gen(function* () {
      const subscriptions = yield* Ref.get(subscriptionsRef);
      return HashMap.size(subscriptions);
    });

  const clear: SubscriptionManagerService["clear"] = () =>
    Effect.gen(function* () {
      yield* Ref.set(subscriptionsRef, HashMap.empty<string, Subscription>());
      yield* Ref.set(byQueryHashRef, HashMap.empty<number, HashSet.HashSet<string>>());
    });

  const findByQueryHash: SubscriptionManagerService["findByQueryHash"] = (queryHash) =>
    Effect.gen(function* () {
      const subscriptions = yield* Ref.get(subscriptionsRef);
      const index = yield* Ref.get(byQueryHashRef);

      const ids = Option.getOrElse(HashMap.get(index, queryHash), () => HashSet.empty<string>());

      const result: Subscription[] = [];
      for (const id of ids) {
        const sub = Option.getOrUndefined(HashMap.get(subscriptions, id));
        if (sub) {
          result.push(sub);
        }
      }
      return result;
    });

  const getQueryHash: SubscriptionManagerService["getQueryHash"] = (query) => hashQuery(query);

  return {
    register,
    unregister,
    checkAffected,
    list,
    get,
    count,
    clear,
    findByQueryHash,
    getQueryHash,
  } satisfies SubscriptionManagerService;
});

// =============================================================================
// Layer
// =============================================================================

/**
 * Layer that provides the SubscriptionManager service.
 */
export const SubscriptionManagerLive = Layer.effect(SubscriptionManager, makeSubscriptionManager);
