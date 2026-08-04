/**
 * DatabaseManager layer implementation
 *
 * Manages database lifecycle with each database backed by a storage backend.
 * Delegates metadata operations to DatabaseRegistry.
 * Handles connection pooling and store/datalog service management.
 */

import { Effect, Layer, HashMap, Ref, pipe, Scope, Exit, Context, Fiber } from "effect";
import {
  DatabaseManager,
  type DatabaseManagerService,
  type Database,
  type ClearResult,
  TripleStore,
  type TripleStoreService,
  TripleStoreLive,
  Datalog,
  type DatalogService,
  DatabaseNotFound,
  InternalError,
  CurrentDialect,
  DatabaseRegistry,
  ChangeEmitter,
  type ChangeEmitterService,
  composeStore,
  type StoreCapability,
  makeChangeEmissionCapability,
  TripleStoreRuntime,
  DatabaseFeatures,
  SnapshotWriter,
  SnapshotService,
  SnapshotWriterLive,
  SnapshotServiceLive,
  makeEntitySnapshotsCapability,
  DatabaseAlreadyExists,
  getTripleStoreRuntime,
  IdGenerator,
} from "@open-ontology/database";
import { DatalogLive } from "./DatalogSqlLayer.js";
import { SqlQueryExecutorLive } from "./SqlQueryExecutor.js";
import { StorageBackend } from "./StorageBackend.js";

// =============================================================================
// Connection Pool Configuration
// =============================================================================

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Check every minute

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Map any error to InternalError
 */
const mapToInternalError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, InternalError, R> =>
  pipe(
    effect,
    Effect.mapError((e) => new InternalError({ message: String(e) })),
  );

// =============================================================================
// Cached Services
// =============================================================================

interface CachedServices {
  store: TripleStoreService;
  datalog: DatalogService;
  snapshotService: import("@open-ontology/database").SnapshotServiceShape;
  scope: Scope.CloseableScope;
  lastAccessedAt: number;
}

// =============================================================================
// Legacy API (re-exported for backwards compat)
// =============================================================================

/**
 * Wrap a TripleStoreService so that every write operation emits a ChangeEvent
 * to the provided ChangeEmitter. Emission failures are logged and swallowed
 * so they never break the underlying mutation.
 *
 * @deprecated Use `makeChangeEmissionCapability` + `composeStore` instead.
 * The `hook` parameter is ignored -- use `makeReactiveConstraintsCapability` for
 * reactive constraint evaluation.
 */
export function wrapStoreWithEmitter(
  store: TripleStoreService,
  emitter: ChangeEmitterService,
  now: () => number,
  _hook?: unknown,
): TripleStoreService {
  const cap = makeChangeEmissionCapability(emitter, Effect.sync(now));
  return cap.wrap(store);
}

// =============================================================================
// Layer Implementation
// =============================================================================

/**
 * DatabaseManagerLive layer
 *
 * Provides the DatabaseManager service.
 * Requires StorageBackend for database operations and DatabaseRegistry for metadata.
 * Optionally accepts ChangeEmitter -- if not provided, uses NoopChangeEmitter.
 *
 * Each database gets a full capability stack:
 * - ReactiveConstraints (priority 40) -- constraint evaluation on write
 * - ChangeEmission (priority 50) -- broadcast changes to connected clients
 */
export const DatabaseManagerLive = Layer.scoped(
  DatabaseManager,
  Effect.gen(function* () {
    const backend = yield* StorageBackend;
    const registry = yield* DatabaseRegistry;

    // Resolve optional services
    const emitter = yield* Effect.serviceOption(ChangeEmitter).pipe(
      Effect.map((opt) =>
        opt._tag === "Some" ? opt.value : ({ emit: () => Effect.void } as ChangeEmitterService),
      ),
    );
    const runtime = yield* getTripleStoreRuntime;
    const ids = yield* IdGenerator;
    const runtimeNow = runtime.now;
    const runtimeLayer = Layer.succeed(TripleStoreRuntime, runtime);
    // Resolve injectable features (optional -- empty if not provided)
    const externalFeatures = yield* Effect.serviceOption(DatabaseFeatures).pipe(
      Effect.map((opt) => (opt._tag === "Some" ? opt.value.features : [])),
    );

    // Cache for database services
    const cacheRef = yield* Ref.make(HashMap.empty<string, CachedServices>());

    // Background fiber to close idle connections
    const cleanupFiber = yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(CLEANUP_INTERVAL_MS);

        const cache = yield* Ref.get(cacheRef);
        const now = yield* runtimeNow;

        for (const [dbName, services] of HashMap.toEntries(cache)) {
          const idleTime = now - services.lastAccessedAt;
          if (idleTime > IDLE_TIMEOUT_MS) {
            yield* Scope.close(services.scope, Exit.void).pipe(Effect.catchAll(() => Effect.void));
            yield* Ref.update(cacheRef, HashMap.remove(dbName));
            yield* Effect.logInfo(
              `Closed idle database connection: ${dbName} (idle for ${Math.round(
                idleTime / 1000,
              )}s)`,
            );
          }
        }
      }
    }).pipe(Effect.fork);

    /**
     * Build the fully-composed layer for a database.
     *
     * Produces: TripleStore + Datalog + SnapshotWriter + SnapshotService
     */
    const buildDatabaseLayer = (database: string) => {
      const adapterLayer = backend.createAdapterLayer(database);
      const sqlLayer = backend.createDatabaseClient(database);
      const dialectLayer = Layer.succeed(CurrentDialect, backend.dialect);

      const storeLayer = TripleStoreLive.pipe(
        Layer.provide(adapterLayer),
        Layer.provide(dialectLayer),
        Layer.provide(runtimeLayer),
      );

      const executorLayer = SqlQueryExecutorLive.pipe(
        Layer.provide(sqlLayer),
        Layer.provide(dialectLayer),
      );

      const datalogLayer = DatalogLive.pipe(
        Layer.provide(storeLayer),
        Layer.provide(executorLayer),
        Layer.provide(dialectLayer),
      );

      const writerLayer = SnapshotWriterLive.pipe(
        Layer.provide(storeLayer),
        Layer.provide(adapterLayer),
      );

      const readerLayer = SnapshotServiceLive.pipe(Layer.provide(adapterLayer));

      return Layer.mergeAll(storeLayer, datalogLayer, writerLayer, readerLayer);
    };

    /**
     * Create services for a database by building and running the layer.
     * Runs feature initialization, then composes the capability stack.
     */
    const createDatabaseServices = (name: string): Effect.Effect<CachedServices, InternalError> =>
      Effect.gen(function* () {
        const layer = buildDatabaseLayer(name);
        const fullyProvidedLayer = layer as Layer.Layer<
          TripleStore | Datalog | SnapshotWriter | SnapshotService
        >;

        const databaseScope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(fullyProvidedLayer, databaseScope).pipe(
          mapToInternalError,
        );

        const rawStore = Context.get(context, TripleStore);
        const datalog = Context.get(context, Datalog);
        const writer = Context.get(context, SnapshotWriter);
        const reader = Context.get(context, SnapshotService);

        // Built-in capabilities
        const capabilities: StoreCapability[] = [
          makeChangeEmissionCapability(emitter, runtimeNow),
          makeEntitySnapshotsCapability(writer, reader),
        ];

        // Add externally-injected feature capabilities (reactive constraints, processes, etc.)
        for (const feature of externalFeatures) {
          if (feature.capabilityFactory) {
            const cap = yield* feature
              .capabilityFactory(rawStore, datalog, runtimeNow)
              .pipe(Effect.provideService(IdGenerator, ids));
            if (cap) {
              capabilities.push(cap);
            }
          }
        }

        const store = composeStore(rawStore, ...capabilities);

        return {
          store,
          datalog,
          snapshotService: reader,
          scope: databaseScope,
          lastAccessedAt: yield* runtimeNow,
        };
      });

    /**
     * Get or create cached services for a database
     */
    const getOrCreateServices = (
      name: string,
    ): Effect.Effect<CachedServices, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        const cache = yield* Ref.get(cacheRef);
        const cached = HashMap.get(cache, name);

        if (cached._tag === "Some") {
          // Update last accessed time
          const updatedServices = {
            ...cached.value,
            lastAccessedAt: yield* runtimeNow,
          };
          yield* Ref.update(cacheRef, HashMap.set(name, updatedServices));
          yield* Effect.logDebug(`Database connection reused from cache: ${name}`);
          return updatedServices;
        }

        // Check if database exists in registry
        yield* registry.get(name);

        // Create services for this database
        const services = yield* createDatabaseServices(name);
        yield* Effect.logInfo(`Database connection created: ${name}`);

        // Cache the services
        yield* Ref.update(cacheRef, HashMap.set(name, services));

        return services;
      });

    /**
     * Get triple count for a database using cached services
     */
    const getTripleCount = (name: string): Effect.Effect<number, InternalError> =>
      Effect.gen(function* () {
        // Try to get from cache first
        const cache = yield* Ref.get(cacheRef);
        const cached = HashMap.get(cache, name);

        if (cached._tag === "Some") {
          // Use the cached store to get count - query all triples with empty pattern
          const triples = yield* cached.value.store
            .query({})
            .pipe(Effect.catchAll(() => Effect.succeed([] as readonly unknown[])));
          return triples.length;
        }

        // Database not in cache, try to create services temporarily
        const services = yield* createDatabaseServices(name).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );

        if (services === null) {
          return 0;
        }

        // Get count and close scope
        const triples = yield* services.store
          .query({})
          .pipe(Effect.catchAll(() => Effect.succeed([] as readonly unknown[])));
        const count = triples.length;

        // Close the temporary scope
        yield* Scope.close(services.scope, Exit.void).pipe(Effect.catchAll(() => Effect.void));

        return count;
      });

    /**
     * Close all cached database connections
     */
    const closeAllConnections = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const cache = yield* Ref.get(cacheRef);
        const count = HashMap.size(cache);
        for (const [, services] of HashMap.toEntries(cache)) {
          yield* Scope.close(services.scope, Exit.void).pipe(Effect.catchAll(() => Effect.void));
        }
        yield* Ref.set(cacheRef, HashMap.empty<string, CachedServices>());
        if (count > 0) {
          yield* Effect.logInfo(`All database connections closed (count: ${count})`);
        }
      });

    // =========================================================================
    // Service Implementation
    // =========================================================================

    const create = (
      name: string,
      description?: string,
    ): Effect.Effect<Database, DatabaseAlreadyExists | InternalError> =>
      Effect.gen(function* () {
        // Register in the registry (this checks for duplicates)
        const database = yield* registry.register(name, description);

        // Pre-initialize the database to create the database file
        const services = yield* createDatabaseServices(name);
        yield* Ref.update(cacheRef, HashMap.set(name, services));
        yield* Effect.logInfo(`Database created: ${name}`);

        return {
          ...database,
          tripleCount: 0,
        };
      });

    const update = (
      name: string,
      fields: { description?: string },
    ): Effect.Effect<Database, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        const database = yield* registry.update(name, fields);

        // Enrich with triple count and size
        const tripleCount = yield* getTripleCount(name);
        const sizeBytes = yield* backend
          .getDatabaseSize(name)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)));

        return {
          ...database,
          tripleCount,
          ...(sizeBytes !== undefined && { sizeBytes }),
        };
      });

    const delete_ = (name: string): Effect.Effect<void, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        // Check if exists (will throw DatabaseNotFound if not)
        yield* registry.get(name);

        // Get and close cached services if exists
        const cache = yield* Ref.get(cacheRef);
        const cached = HashMap.get(cache, name);
        if (cached._tag === "Some") {
          yield* Scope.close(cached.value.scope, Exit.void).pipe(
            Effect.catchAll(() => Effect.void),
          );
          yield* Effect.logInfo(`Database connection closed: ${name}`);
        }

        // Remove from cache
        yield* Ref.update(cacheRef, HashMap.remove(name));

        // Unregister from registry
        yield* registry.unregister(name);

        // Delete database storage using the backend
        yield* backend.deleteDatabaseStorage(name).pipe(Effect.catchAll(() => Effect.void));

        yield* Effect.logInfo(`Database deleted: ${name}`);
      });

    const deleteAll = (): Effect.Effect<void, InternalError> =>
      Effect.gen(function* () {
        // Close all cached connections first
        yield* closeAllConnections();

        // Clear the registry
        yield* registry.clear();

        // Delete all storage (including registry)
        yield* backend.deleteAllStorage().pipe(mapToInternalError);
      });

    const list = (): Effect.Effect<readonly Database[], InternalError> =>
      Effect.gen(function* () {
        // Get base metadata from registry
        const databases = yield* registry.list();

        // Enrich with triple count and size
        const enrichedDatabases: Database[] = [];
        for (const db of databases) {
          const tripleCount = yield* getTripleCount(db.name);
          const sizeBytes = yield* backend
            .getDatabaseSize(db.name)
            .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
          enrichedDatabases.push({
            ...db,
            tripleCount,
            ...(sizeBytes !== undefined && { sizeBytes }),
          });
        }

        return enrichedDatabases;
      });

    const get = (name: string): Effect.Effect<Database, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        // Get base metadata from registry
        const database = yield* registry.get(name);

        // Enrich with triple count and size
        const tripleCount = yield* getTripleCount(name);
        const sizeBytes = yield* backend
          .getDatabaseSize(name)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)));

        return {
          ...database,
          tripleCount,
          ...(sizeBytes !== undefined && { sizeBytes }),
        };
      });

    const getStore = (
      name: string,
    ): Effect.Effect<TripleStoreService, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        const cached = yield* getOrCreateServices(name);
        return cached.store;
      });

    const getDatalog = (
      name: string,
    ): Effect.Effect<DatalogService, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        const cached = yield* getOrCreateServices(name);
        return cached.datalog;
      });

    const getSnapshotService = (
      name: string,
    ): Effect.Effect<
      import("@open-ontology/database").SnapshotServiceShape | null,
      DatabaseNotFound | InternalError
    > =>
      Effect.gen(function* () {
        const cached = yield* getOrCreateServices(name);
        return cached.snapshotService ?? null;
      });

    const clear = (name: string): Effect.Effect<ClearResult, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        // Get database info to preserve description
        const databaseInfo = yield* get(name);
        const description = databaseInfo.description ?? undefined;

        // Hard reset: delete database and recreate it
        yield* delete_(name).pipe(Effect.catchTag("DatabaseNotFound", () => Effect.void));
        yield* create(name, description).pipe(
          Effect.catchTag("DatabaseAlreadyExists", () => Effect.void),
        );

        return {
          success: true,
          database: name,
        };
      });

    // Clean up when the manager is closed
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Stop the cleanup fiber
        yield* Fiber.interrupt(cleanupFiber);
        yield* Effect.logInfo("Database manager finalized");
      }),
    );

    return {
      create,
      update,
      delete: delete_,
      deleteAll,
      list,
      get,
      getStore,
      getDatalog,
      getSnapshotService,
      clear,
    } satisfies DatabaseManagerService;
  }),
);
