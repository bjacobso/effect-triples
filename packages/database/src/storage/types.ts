/**
 * Storage Layer Types
 *
 * Shared types for the storage adapter abstraction layer.
 */

import type { TripleInput, TripleRow, TripleValue } from "@open-ontology/database";
import type { Pattern, Variable } from "../types/Pattern.js";

// Re-export commonly used types
export type { TripleInput, TripleRow };

/**
 * Query pattern for filtering triples at the storage layer.
 */
export interface QueryPattern {
  readonly entityId?: string | Variable;
  readonly attribute?: string | Variable;
  readonly entityType?: string;
  readonly value?: TripleValue | Variable;
}

export type { Pattern };

/**
 * Result of a transaction containing the transaction ID
 */
export interface TransactionInfo {
  readonly txId: string;
  readonly timestamp: number;
}
