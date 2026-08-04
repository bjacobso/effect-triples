/**
 * Database Module
 *
 * Schemas for database management - creating, listing, and managing databases.
 */

import { Schema } from "effect";
import { DatabaseName as DatabaseNamePrimitive } from "./Branded.js";

// =============================================================================
// Database Name
// =============================================================================

/**
 * Valid database name: database-native primitive owned by effect-triples
 */
const DatabaseName = DatabaseNamePrimitive.annotations({
  identifier: "DatabaseName",
  description: "A valid database name (kebab-case, 1-64 chars)",
});

// =============================================================================
// Create Database
// =============================================================================

/**
 * Request to create a new database
 */
export const CreateDatabaseRequest = Schema.Struct({
  name: DatabaseName,
  description: Schema.optional(Schema.String),
});
export type CreateDatabaseRequest = typeof CreateDatabaseRequest.Type;

/**
 * Request to update a database
 */
export const UpdateDatabaseRequest = Schema.Struct({
  description: Schema.optional(Schema.String),
});
export type UpdateDatabaseRequest = typeof UpdateDatabaseRequest.Type;

/**
 * Database metadata response
 */
export const DatabaseResponse = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  tripleCount: Schema.optional(Schema.Number),
  sizeBytes: Schema.optional(Schema.Number),
});
export type DatabaseResponse = typeof DatabaseResponse.Type;

// =============================================================================
// Health Check
// =============================================================================

/**
 * Health check response
 */
export const HealthCheckResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  timestamp: Schema.Number,
  version: Schema.optional(Schema.String),
});
export type HealthCheckResponse = typeof HealthCheckResponse.Type;

/**
 * Telemetry health check response
 */
export const TelemetryHealthResponse = Schema.Struct({
  status: Schema.Literal("ok", "disabled"),
  otelEnabled: Schema.Boolean,
  exporterEndpoint: Schema.optional(Schema.String),
  serviceName: Schema.optional(Schema.String),
  testSpanCreated: Schema.Boolean,
  timestamp: Schema.Number,
});
export type TelemetryHealthResponse = typeof TelemetryHealthResponse.Type;

/**
 * Root endpoint response
 */
export const RootResponse = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  docs: Schema.String,
  health: Schema.String,
});
export type RootResponse = typeof RootResponse.Type;

// =============================================================================
// Reset/Demo
// =============================================================================

/**
 * Response for reset endpoint
 */
export const ResetResponse = Schema.Struct({
  success: Schema.Boolean,
  database: Schema.String,
  tripleCount: Schema.Number,
  /** Number of entity types seeded (demo-hr only) */
  entityTypeCount: Schema.optional(Schema.Number),
  /** Number of constraints seeded (demo-hr only) */
  constraintCount: Schema.optional(Schema.Number),
  /** Number of violations detected (demo-hr only) */
  violationCount: Schema.optional(Schema.Number),
  /** Number of tasks created (demo-hr only) */
  taskCount: Schema.optional(Schema.Number),
});
export type ResetResponse = typeof ResetResponse.Type;

// =============================================================================
// Generate Name
// =============================================================================

/**
 * Response for generate name endpoint
 */
export const GenerateNameResponse = Schema.Struct({
  name: Schema.String,
});
export type GenerateNameResponse = typeof GenerateNameResponse.Type;

// =============================================================================
// Clear Database
// =============================================================================

/**
 * Response for clear database endpoint
 */
export const ClearDatabaseResponse = Schema.Struct({
  success: Schema.Boolean,
  database: Schema.String,
});
export type ClearDatabaseResponse = typeof ClearDatabaseResponse.Type;

// =============================================================================
// Import DSL
// =============================================================================

// =============================================================================
// Export / Import Triples
// =============================================================================

/**
 * A single triple in export format
 */
export const ExportedTriple = Schema.Struct({
  entityId: Schema.String,
  attribute: Schema.String,
  value: Schema.Unknown,
  createdAt: Schema.optional(Schema.Number),
  entityType: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ExportedTriple = typeof ExportedTriple.Type;

/**
 * Response for export triples endpoint
 */
export const ExportTriplesResponse = Schema.Struct({
  database: Schema.String,
  exportedAt: Schema.Number,
  tripleCount: Schema.Number,
  triples: Schema.Array(ExportedTriple),
});
export type ExportTriplesResponse = typeof ExportTriplesResponse.Type;

/**
 * Request to import triples
 */
export const ImportTriplesRequest = Schema.Struct({
  triples: Schema.Array(
    Schema.Struct({
      entityId: Schema.String,
      attribute: Schema.String,
      value: Schema.Unknown,
      entityType: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type ImportTriplesRequest = typeof ImportTriplesRequest.Type;

/**
 * Response for import triples endpoint
 */
export const ImportTriplesResponse = Schema.Struct({
  success: Schema.Boolean,
  database: Schema.String,
  importedCount: Schema.Number,
});
export type ImportTriplesResponse = typeof ImportTriplesResponse.Type;

// =============================================================================
// Import DSL
// =============================================================================

/**
 * Example type options - all available example IDs
 */
export const ExampleType = Schema.Literal(
  "teams",
  "company",
  "hr",
  "performance-reviews",
  "staffing",
  "insurance",
  "dataroom",
  "labor-union",
  "chronicle",
  "bookstore",
  "todo-app",
  "movies",
  "family",
  "fantasy",
  "dnd",
  "real-estate",
  "bizops",
  "law-firm",
);
export type ExampleType = typeof ExampleType.Type;

/**
 * Request to import a DSL example into a database
 */
export const ImportDslRequest = Schema.Struct({
  exampleType: ExampleType,
});
export type ImportDslRequest = typeof ImportDslRequest.Type;

/**
 * Response for import DSL endpoint
 */
export const ImportDslResponse = Schema.Struct({
  success: Schema.Boolean,
  database: Schema.String,
  exampleType: ExampleType,
  tripleCount: Schema.Number,
  entityTypeCount: Schema.Number,
  relationshipTypeCount: Schema.Number,
  relationshipCount: Schema.Number,
  constraintCount: Schema.Number,
  violationCount: Schema.Number,
  taskCount: Schema.Number,
  queryCount: Schema.Number,
});
export type ImportDslResponse = typeof ImportDslResponse.Type;
