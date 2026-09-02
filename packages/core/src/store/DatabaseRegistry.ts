/**
 * DatabaseRegistry service definition
 *
 * Manages database metadata (name, description, createdAt) and
 * database access control (which users can access which databases).
 *
 * Implementations:
 * - Node.js: SQLite registry file (_registry.db)
 * - Cloudflare: RegistryDO (Durable Object with SQLite storage)
 */

import { Context, Effect } from "effect";
import type { Database } from "./DatabaseManager.js";
import type { DatabaseNotFound, DatabaseAlreadyExists, InternalError } from "../Error.js";

// =============================================================================
// Access Control Types
// =============================================================================

export interface DatabaseAccessEntry {
  readonly userId: string;
  readonly databaseName: string;
  readonly role: "owner" | "member";
  readonly createdAt: number;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * DatabaseRegistry service interface
 *
 * Handles metadata and access control operations - no database storage management.
 */
export interface DatabaseRegistryService {
  /**
   * List all registered databases
   */
  readonly list: () => Effect.Effect<readonly Database[], InternalError>;

  /**
   * Register a new database
   * Does not create the actual database storage - just records metadata
   */
  readonly register: (
    name: string,
    description?: string,
  ) => Effect.Effect<Database, DatabaseAlreadyExists | InternalError>;

  /**
   * Unregister a database
   * Does not delete the actual database storage - just removes metadata
   */
  readonly unregister: (name: string) => Effect.Effect<void, DatabaseNotFound | InternalError>;

  /**
   * Get database metadata
   */
  readonly get: (name: string) => Effect.Effect<Database, DatabaseNotFound | InternalError>;

  /**
   * Update database metadata (description only — name is immutable)
   */
  readonly update: (
    name: string,
    fields: { description?: string },
  ) => Effect.Effect<Database, DatabaseNotFound | InternalError>;

  /**
   * Clear all registered databases
   * Does not delete actual database storage - just clears metadata
   */
  readonly clear: () => Effect.Effect<void, InternalError>;

  // ===========================================================================
  // Access Control
  // ===========================================================================

  /**
   * Grant a user access to a database (upserts)
   */
  readonly grantAccess: (
    userId: string,
    databaseName: string,
    role: "owner" | "member",
  ) => Effect.Effect<DatabaseAccessEntry, DatabaseNotFound | InternalError>;

  /**
   * Revoke a user's access to a database
   */
  readonly revokeAccess: (
    userId: string,
    databaseName: string,
  ) => Effect.Effect<void, DatabaseNotFound | InternalError>;

  /**
   * List all access entries for a database
   */
  readonly listAccess: (
    databaseName: string,
  ) => Effect.Effect<readonly DatabaseAccessEntry[], DatabaseNotFound | InternalError>;

  /**
   * List all databases a user has access to
   */
  readonly listUserDatabases: (
    userId: string,
  ) => Effect.Effect<readonly DatabaseAccessEntry[], InternalError>;

  /**
   * Check if a user has access to a database.
   * Access is fail-closed and requires an explicit grant.
   */
  readonly hasAccess: (
    userId: string,
    databaseName: string,
  ) => Effect.Effect<boolean, InternalError>;
}

/**
 * DatabaseRegistry service tag for dependency injection
 */
export class DatabaseRegistry extends Context.Service<DatabaseRegistry, DatabaseRegistryService>()(
  "DatabaseRegistry",
) {}
