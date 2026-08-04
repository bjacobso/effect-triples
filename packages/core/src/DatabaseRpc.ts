/**
 * Database RPC
 *
 * Protocol-agnostic operations for database management.
 * Used by both HTTP handlers and CLI commands.
 */

import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import {
  CreateDatabaseRequest,
  DatabaseResponse,
  ClearDatabaseResponse,
  ImportDslRequest,
  ImportDslResponse,
  GenerateNameResponse,
} from "./Database.js";
import { DatabaseName } from "./Branded.js";
import { DatabaseNotFound, DatabaseAlreadyExists, InternalError } from "./Error.js";

// =============================================================================
// Database RPC Group
// =============================================================================

/**
 * RPC operations for database management.
 *
 * These operations mirror the DatabaseApi HTTP endpoints but are
 * protocol-agnostic, allowing them to be used over HTTP, WebSocket,
 * or directly in-process (e.g., from CLI).
 */
export class DatabaseRpc extends RpcGroup.make(
  /**
   * Create a new database
   */
  Rpc.make("database.create", {
    payload: CreateDatabaseRequest,
    success: DatabaseResponse,
    error: Schema.Union(DatabaseAlreadyExists, InternalError),
  }),

  /**
   * List all databases
   */
  Rpc.make("database.list", {
    success: Schema.Array(DatabaseResponse),
    error: InternalError,
  }),

  /**
   * Get a specific database by name
   */
  Rpc.make("database.get", {
    payload: Schema.Struct({
      name: DatabaseName,
    }),
    success: DatabaseResponse,
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),

  /**
   * Delete a database
   */
  Rpc.make("database.delete", {
    payload: Schema.Struct({
      name: DatabaseName,
    }),
    success: Schema.Void,
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),

  /**
   * Delete all databases (factory reset)
   */
  Rpc.make("database.deleteAll", {
    success: Schema.Void,
    error: InternalError,
  }),

  /**
   * Generate a random database name
   */
  Rpc.make("database.generateName", {
    success: GenerateNameResponse,
    error: InternalError,
  }),

  /**
   * Clear all data in a database
   */
  Rpc.make("database.clear", {
    payload: Schema.Struct({
      name: DatabaseName,
    }),
    success: ClearDatabaseResponse,
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),

  /**
   * Seed a database with demo data
   */
  Rpc.make("database.seed", {
    payload: Schema.Struct({
      name: DatabaseName,
      exampleType: ImportDslRequest.fields.exampleType,
    }),
    success: ImportDslResponse,
    error: Schema.Union(DatabaseNotFound, InternalError),
  }),
) {}
