/**
 * Query Hashing for Subscription Deduplication
 *
 * Uses Effect's Hash module to create consistent hashes for Datalog queries.
 * Structurally identical queries produce the same hash, enabling:
 * - Deduplication of identical subscriptions
 * - Fast lookup of subscriptions by query structure
 * - Potential use as reactivity keys for frontend caching
 */

import { Hash } from "effect";
import type { DatalogQuery } from "../Datalog.js";

/**
 * Hash a Datalog query using Effect's Hash module.
 *
 * Two structurally identical queries will produce the same hash.
 * The hash is a 32-bit integer, so collisions are possible but rare.
 * Collisions are acceptable since they only result in extra invalidation
 * checks (conservative approach - no false negatives).
 *
 * @example
 * ```typescript
 * const query1: DatalogQuery = {
 *   find: ["?name"],
 *   where: [["?emp", ":employee/name", "?name"]],
 * };
 * const query2: DatalogQuery = {
 *   find: ["?name"],
 *   where: [["?emp", ":employee/name", "?name"]],
 * };
 *
 * hashQuery(query1) === hashQuery(query2) // true
 * ```
 *
 * @param query The Datalog query to hash
 * @returns A 32-bit integer hash
 */
export function hashQuery(query: DatalogQuery): number {
  // JSON.stringify produces a canonical string representation
  // Then we hash that string using Effect's Hash.string
  // This ensures structurally identical queries produce the same hash
  return Hash.string(JSON.stringify(query));
}
