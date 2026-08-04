/**
 * Database API
 *
 * HTTP API endpoints for database management.
 */

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
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
// Path Parameters
// =============================================================================

const databaseParam = HttpApiSchema.param("database", Schema.String);

// =============================================================================
// Root Group
// =============================================================================

export class RootApi extends HttpApiGroup.make("root").add(
  HttpApiEndpoint.get("home", "/").addSuccess(RootResponse).addError(InternalError),
) {}

// =============================================================================
// Health Group
// =============================================================================

export class HealthApi extends HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("check", "/health").addSuccess(HealthCheckResponse).addError(InternalError),
  )
  .add(
    HttpApiEndpoint.get("telemetry", "/health/telemetry")
      .addSuccess(TelemetryHealthResponse)
      .addError(InternalError),
  ) {}

// =============================================================================
// Demo Group (per-database operations under /db/{database})
// =============================================================================

export class DemoApi extends HttpApiGroup.make("demo").add(
  HttpApiEndpoint.post("reset")`/db/${databaseParam}/reset`
    .addSuccess(ResetResponse)
    .addError(DatabaseNotFound)
    .addError(InternalError),
) {}

// =============================================================================
// Database API Group (admin operations under /admin/databases)
// =============================================================================

export class DatabaseApi extends HttpApiGroup.make("databases")
  .add(
    // Create a new database
    HttpApiEndpoint.post("create", "/admin/databases")
      .setPayload(CreateDatabaseRequest)
      .addSuccess(DatabaseResponse)
      .addError(DatabaseAlreadyExists)
      .addError(InternalError),
  )
  .add(
    // List all databases
    HttpApiEndpoint.get("list", "/admin/databases")
      .addSuccess(Schema.Array(DatabaseResponse))
      .addError(InternalError),
  )
  .add(
    // Get a specific database
    HttpApiEndpoint.get("get")`/admin/databases/${databaseParam}`
      .addSuccess(DatabaseResponse)
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    // Update a database (description)
    HttpApiEndpoint.patch("update")`/admin/databases/${databaseParam}`
      .setPayload(UpdateDatabaseRequest)
      .addSuccess(DatabaseResponse)
      .addError(DatabaseNotFound)
      .addError(AccessDenied)
      .addError(InternalError),
  )
  .add(
    // Delete a database
    HttpApiEndpoint.del("delete")`/admin/databases/${databaseParam}`
      .addError(DatabaseNotFound)
      .addError(AccessDenied)
      .addError(InternalError),
  )
  .add(
    // Delete all databases including registry (factory reset)
    HttpApiEndpoint.del("deleteAll", "/admin/databases").addError(InternalError),
  )
  .add(
    // Generate a random database name
    HttpApiEndpoint.get("generateName", "/admin/databases/generate-name")
      .addSuccess(GenerateNameResponse)
      .addError(InternalError),
  )
  .add(
    // Clear all data in a database (per-db operation)
    HttpApiEndpoint.post("clear")`/db/${databaseParam}/clear`
      .addSuccess(ClearDatabaseResponse)
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    // Import a DSL example into a database (per-db operation)
    HttpApiEndpoint.post("seed")`/db/${databaseParam}/seed`
      .setPayload(ImportDslRequest)
      .addSuccess(ImportDslResponse)
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    // Export all triples from a database as JSON
    HttpApiEndpoint.get("exportTriples")`/db/${databaseParam}/export`
      .addSuccess(ExportTriplesResponse)
      .addError(DatabaseNotFound)
      .addError(InternalError),
  )
  .add(
    // Import triples into a database from JSON
    HttpApiEndpoint.post("importTriples")`/db/${databaseParam}/import`
      .setPayload(ImportTriplesRequest)
      .addSuccess(ImportTriplesResponse)
      .addError(DatabaseNotFound)
      .addError(InternalError),
  ) {}
