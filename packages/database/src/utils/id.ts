/**
 * Minimal ID generation utilities for the database package.
 *
 * Only includes what the database layer needs directly.
 * The full id utility set lives in @open-ontology/core/utils.
 */

import { ulid } from "ulidx";

/**
 * Generate a transaction ID.
 */
export const generateTransactionId = (): string => `_tx/${ulid()}`;

/**
 * Transaction metadata attributes.
 */
export const TxAttributes = {
  /** Timestamp when the transaction occurred (epoch millis) */
  INSTANT: ":_tx/instant",
  /** User who performed the transaction */
  USER: ":_tx/user",
} as const;

/**
 * System entity prefixes used by the database layer.
 */
export const SystemPrefixes = {
  TRANSACTION: "_tx",
} as const;
