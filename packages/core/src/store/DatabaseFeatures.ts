/**
 * Generic database extension hook.
 *
 * Features can contribute schema (tables/indexes), store capabilities
 * (write interceptors), and additional services. This replaces the
 * narrower DatabaseCapabilities with a single extension contract.
 *
 * Features are opt-in at composition time — the base database package
 * has no features installed by default (only built-in change emission).
 */

import { Context, Effect } from "effect";
import type { StoreCapability } from "./StoreCapability.js";
import type { TripleStoreService } from "./TripleStore.js";
import type { DatalogService } from "../datalog/service.js";
import type { StorageAdapterService } from "../storage/StorageAdapter.js";
import type { WriteError, ReadError } from "../errors/index.js";
import type { IdGenerator } from "./RuntimeServices.js";

/**
 * A database feature that can extend the database with schema,
 * capabilities, and services.
 */
export interface DatabaseFeature {
  /** Human-readable name for logging */
  readonly name: string;

  /**
   * Initialize schema (create tables, indexes, etc.) for this feature.
   * Called once per database during bootstrap, before capabilities run.
   * Should be idempotent.
   */
  readonly initialize?: (
    adapter: StorageAdapterService,
  ) => Effect.Effect<void, ReadError | WriteError>;

  /**
   * Factory that produces a store capability for this feature.
   * Called after initialize, receives the raw store + datalog.
   * Return null to skip (graceful degradation).
   */
  readonly capabilityFactory?: (
    store: TripleStoreService,
    datalog: DatalogService,
    now: Effect.Effect<number>,
  ) => Effect.Effect<StoreCapability | null, never, IdGenerator>;
}

/**
 * Service tag providing database features to DatabaseManager.
 *
 * Application layers (node server, cloudflare worker) provide this to
 * install features like snapshots, reactive constraints, process triggers.
 *
 * If not provided, DatabaseManager uses only the built-in change emission.
 */
export class DatabaseFeatures extends Context.Tag("DatabaseFeatures")<
  DatabaseFeatures,
  {
    readonly features: readonly DatabaseFeature[];
  }
>() {}
