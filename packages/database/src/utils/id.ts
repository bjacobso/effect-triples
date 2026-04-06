/**
 * Minimal ID generation utilities for the database package.
 *
 * Only includes what the database layer needs directly.
 * Runtime-owned metadata and higher-level ID helpers live in @open-ontology/runtime.
 */

import { ulid } from "ulidx";
import type { TripleId } from "../Branded.js";

/**
 * Generate a new ULID (TripleId).
 */
export const generateId = (): TripleId => ulid() as TripleId;

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
