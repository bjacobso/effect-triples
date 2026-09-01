/**
 * DatabaseManager service definition
 *
 * Manages database lifecycle and provides database-scoped Triples services.
 * Each database is backed by a storage backend (SQLite, PostgreSQL, etc.).
 *
 * This is a pure database concern — no runtime services (snapshots, compliance, etc.).
 */

import { Context, Effect } from "effect";
import type { TriplesService } from "./Triples.js";
import type { DatabaseNotFound, DatabaseAlreadyExists, InternalError } from "../Error.js";

/**
 * Database metadata
 */
export interface Database {
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: number;
  readonly tripleCount?: number;
  readonly sizeBytes?: number;
}

/**
 * Result of clearing a database
 */
export interface ClearResult {
  readonly success: boolean;
  readonly database: string;
}

/**
 * DatabaseManager service interface
 *
 * All operations can fail with InternalError for database/filesystem issues.
 */
export interface DatabaseManagerService {
  readonly create: (
    name: string,
    description?: string,
  ) => Effect.Effect<Database, DatabaseAlreadyExists | InternalError>;

  readonly update: (
    name: string,
    fields: { description?: string },
  ) => Effect.Effect<Database, DatabaseNotFound | InternalError>;

  readonly delete: (name: string) => Effect.Effect<void, DatabaseNotFound | InternalError>;

  readonly deleteAll: () => Effect.Effect<void, InternalError>;

  readonly list: () => Effect.Effect<readonly Database[], InternalError>;

  readonly get: (name: string) => Effect.Effect<Database, DatabaseNotFound | InternalError>;

  readonly getTriples: (
    name: string,
  ) => Effect.Effect<TriplesService, DatabaseNotFound | InternalError>;

  readonly getSnapshotService: (
    name: string,
  ) => Effect.Effect<
    import("../snapshots/SnapshotService.js").SnapshotServiceShape | null,
    DatabaseNotFound | InternalError
  >;

  readonly clear: (name: string) => Effect.Effect<ClearResult, DatabaseNotFound | InternalError>;
}

/**
 * DatabaseManager service tag for dependency injection
 */
export class DatabaseManager extends Context.Service<DatabaseManager, DatabaseManagerService>()(
  "DatabaseManager",
) {}
