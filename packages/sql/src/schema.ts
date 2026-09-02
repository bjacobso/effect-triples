/**
 * Centralized Schema Definitions
 *
 * This is the single source of truth for all database DDL.
 * Both Node.js (migrations.ts) and Cloudflare (CloudflareAdapter.ts) import from here.
 *
 * Why centralize:
 * - Prevents schema drift between platforms
 * - Single place to update when adding columns/indexes
 * - Enables sharing between different adapters
 */

// =============================================================================
// Table Definitions
// =============================================================================

/**
 * Triples table DDL
 *
 * Core table storing all facts as entity-attribute-value triples.
 * Supports:
 * - Multiple value types (string, number, boolean, datetime, ref, json)
 * - Recorded-time history via recorded_at/retracted_at timestamps
 * - Business-time history via valid_from/valid_to timestamps
 * - Entity typing for schema validation
 * - Transaction grouping via tx_id
 */
export const TRIPLES_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triples (
    id TEXT PRIMARY KEY NOT NULL,
    entity_id TEXT NOT NULL,
    attribute TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'datetime', 'ref', 'json', 'blob')),
    value_string TEXT,
    value_number DOUBLE PRECISION,
    value_boolean INTEGER,
    value_datetime BIGINT,
    value_json TEXT,
    recorded_at BIGINT NOT NULL,
    recorded_position BIGINT NOT NULL,
    valid_from BIGINT NOT NULL,
    valid_to BIGINT,
    created_by TEXT,
    retracted_at BIGINT,
    retracted_position BIGINT,
    retract_tx_id TEXT,
    entity_type TEXT,
    schema_version INTEGER DEFAULT 1,
    tx_id TEXT
  )
`;

/**
 * Schema migrations table DDL
 *
 * Tracks applied migrations for versioned schema updates.
 */
export const MIGRATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at BIGINT NOT NULL
  )
`;

/**
 * Single-row counter used to assign a total order to committed transactions.
 * The increment occurs inside the same backend transaction as the fact writes.
 */
export const COMMIT_POSITION_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_commit_position (
    singleton INTEGER PRIMARY KEY,
    position BIGINT NOT NULL
  )
`;

// =============================================================================
// Index Definitions
// =============================================================================

/**
 * All index definitions for the triples table.
 *
 * These indexes optimize common query patterns:
 * - Entity lookups (idx_entity)
 * - Attribute scans (idx_attribute)
 * - Type filtering (idx_type)
 * - Value searches (idx_attr_string, idx_attr_number)
 * - Reference traversal (idx_ref_target)
 * - Time travel queries (idx_temporal)
 * - Entity+attribute lookups (idx_entity_attr)
 * - Transaction queries (idx_tx_id)
 */
export const INDEX_DDLS = [
  "CREATE INDEX IF NOT EXISTS idx_entity ON triples(entity_id) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_attribute ON triples(attribute) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_type ON triples(entity_type) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_attr_string ON triples(attribute, value_string) WHERE retracted_at IS NULL AND value_type = 'string'",
  "CREATE INDEX IF NOT EXISTS idx_attr_number ON triples(attribute, value_number) WHERE retracted_at IS NULL AND value_type = 'number'",
  "CREATE INDEX IF NOT EXISTS idx_ref_target ON triples(value_string) WHERE retracted_at IS NULL AND value_type = 'ref'",
  "CREATE INDEX IF NOT EXISTS idx_temporal ON triples(entity_id, recorded_at, retracted_at, valid_from, valid_to)",
  "CREATE INDEX IF NOT EXISTS idx_recorded_position ON triples(recorded_position, retracted_position)",
  "CREATE INDEX IF NOT EXISTS idx_entity_attr ON triples(entity_id, attribute) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_tx_id ON triples(tx_id) WHERE retracted_at IS NULL",
] as const;

/**
 * Index names for drop/recreate operations during bulk loading
 */
export const INDEX_NAMES = [
  "idx_entity",
  "idx_attribute",
  "idx_type",
  "idx_attr_string",
  "idx_attr_number",
  "idx_ref_target",
  "idx_temporal",
  "idx_recorded_position",
  "idx_entity_attr",
  "idx_tx_id",
] as const;

// =============================================================================
// Entity Snapshot Tables
// =============================================================================

/**
 * Content-addressed blob storage for entity snapshots.
 *
 * Each unique entity state (canonical JSON of attribute map) is stored once.
 * The hash is a `sha256-<64 hex>` ContentId over the entity-snapshot domain,
 * canonical version, and canonical JSON.
 * Deduplication is automatic — two entities with identical attributes share one blob.
 */
export const ENTITY_BLOBS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS entity_blobs (
    hash TEXT PRIMARY KEY NOT NULL,
    data TEXT NOT NULL,
    format_version INTEGER NOT NULL DEFAULT 1,
    byte_size INTEGER NOT NULL,
    ref_count INTEGER NOT NULL DEFAULT 1
  )
`;

/**
 * Entity snapshot pointers — one row per entity per transaction that touched it.
 *
 * The hash column references entity_blobs.hash (content address).
 * This table tracks the entity's state at each transaction point,
 * enabling O(1) change detection and time-travel entity reads.
 */
export const ENTITY_SNAPSHOTS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS entity_snapshots (
    entity_id TEXT NOT NULL,
    tx_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    tx_time BIGINT NOT NULL,
    tx_position BIGINT,
    entity_type TEXT,
    PRIMARY KEY (entity_id, tx_id)
  )
`;

/**
 * Indexes for entity snapshot queries.
 */
export const SNAPSHOT_INDEX_DDLS = [
  "CREATE INDEX IF NOT EXISTS idx_snapshot_entity ON entity_snapshots(entity_id, tx_time DESC)",
  "CREATE INDEX IF NOT EXISTS idx_snapshot_tx ON entity_snapshots(tx_id)",
  "CREATE INDEX IF NOT EXISTS idx_snapshot_hash ON entity_snapshots(hash)",
  "CREATE INDEX IF NOT EXISTS idx_snapshot_type ON entity_snapshots(entity_type, tx_time DESC)",
  "CREATE INDEX IF NOT EXISTS idx_snapshot_position ON entity_snapshots(entity_id, tx_position DESC, tx_time DESC)",
] as const;
