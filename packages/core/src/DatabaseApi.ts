/**
 * Database API
 *
 * HTTP API endpoints for database management.
 */

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { DatabaseNotFound, DatabaseAlreadyExists, InternalError, AccessDenied } from "./Error.js";
import {
  CreateDatabaseRequest,
  UpdateDatabaseRequest,
  DatabaseResponse,
  HealthCheckResponse,
  TelemetryHealthResponse,
  RootResponse,
  ResetResponse,
  GenerateNameResponse,
  ClearDatabaseResponse,
  ImportDslRequest,
  ImportDslResponse,
  ExportTriplesResponse,
  ImportTriplesRequest,
  ImportTriplesResponse,
} from "./Database.js";

// =============================================================================
// Root Group
// =============================================================================

export class RootApi extends HttpApiGroup.make("root").add(
  HttpApiEndpoint.get("home", "/", { success: RootResponse, error: InternalError }),
) {}

// =============================================================================
// Health Group
// =============================================================================

export class HealthApi extends HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("check", "/health", {
      success: HealthCheckResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("telemetry", "/health/telemetry", {
      success: TelemetryHealthResponse,
      error: InternalError,
    }),
  ) {}

// =============================================================================
// Demo Group (per-database operations under /db/{database})
// =============================================================================

export class DemoApi extends HttpApiGroup.make("demo").add(
  HttpApiEndpoint.post("reset", "/db/:database/reset", {
    params: { database: Schema.String },
    success: ResetResponse,
    error: [DatabaseNotFound, InternalError],
  }),
) {}

// =============================================================================
// Database API Group (admin operations under /admin/databases)
// =============================================================================

export class DatabaseApi extends HttpApiGroup.make("databases")
  .add(
    // Create a new database
    HttpApiEndpoint.post("create", "/admin/databases", {
      payload: CreateDatabaseRequest,
      success: DatabaseResponse,
      error: [DatabaseAlreadyExists, InternalError],
    }),
  )
  .add(
    // List all databases
    HttpApiEndpoint.get("list", "/admin/databases", {
      success: Schema.Array(DatabaseResponse),
      error: InternalError,
    }),
  )
  .add(
    // Get a specific database
    HttpApiEndpoint.get("get", "/admin/databases/:database", {
      params: { database: Schema.String },
      success: DatabaseResponse,
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    // Update a database (description)
    HttpApiEndpoint.patch("update", "/admin/databases/:database", {
      params: { database: Schema.String },
      payload: UpdateDatabaseRequest,
      success: DatabaseResponse,
      error: [DatabaseNotFound, AccessDenied, InternalError],
    }),
  )
  .add(
    // Delete a database
    HttpApiEndpoint.delete("delete", "/admin/databases/:database", {
      params: { database: Schema.String },
      error: [DatabaseNotFound, AccessDenied, InternalError],
    }),
  )
  .add(
    // Delete all databases including registry (factory reset)
    HttpApiEndpoint.delete("deleteAll", "/admin/databases", { error: InternalError }),
  )
  .add(
    // Generate a random database name
    HttpApiEndpoint.get("generateName", "/admin/databases/generate-name", {
      success: GenerateNameResponse,
      error: InternalError,
    }),
  )
  .add(
    // Clear all data in a database (per-db operation)
    HttpApiEndpoint.post("clear", "/db/:database/clear", {
      params: { database: Schema.String },
      success: ClearDatabaseResponse,
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    // Import a DSL example into a database (per-db operation)
    HttpApiEndpoint.post("seed", "/db/:database/seed", {
      params: { database: Schema.String },
      payload: ImportDslRequest,
      success: ImportDslResponse,
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    // Export all triples from a database as JSON
    HttpApiEndpoint.get("exportTriples", "/db/:database/export", {
      params: { database: Schema.String },
      success: ExportTriplesResponse,
      error: [DatabaseNotFound, InternalError],
    }),
  )
  .add(
    // Import triples into a database from JSON
    HttpApiEndpoint.post("importTriples", "/db/:database/import", {
      params: { database: Schema.String },
      payload: ImportTriplesRequest,
      success: ImportTriplesResponse,
      error: [DatabaseNotFound, InternalError],
    }),
  ) {}
