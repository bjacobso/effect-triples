/**
 * FoundationDB backend for the KvBackend interface.
 *
 * Implements `KvBackendService` using the `foundationdb` npm package.
 * FoundationDB provides:
 * - Ordered key-value storage (natural fit for hexastore index scans)
 * - ACID transactions with optimistic concurrency (5-second limit)
 * - Distributed, multi-node scalability
 * - Key prefix isolation for multi-tenancy
 *
 * Prerequisites:
 * - FoundationDB server installed and running
 * - `libfdb_c` client library on the system path
 *
 * @example
 * ```typescript
 * // Default: connects to local FDB, no subspace prefix
 * const layer = makeFdbKvBackend();
 *
 * // With subspace isolation (e.g., per-tenant)
 * const layer = makeFdbKvBackend({
 *   subspace: Buffer.from("ontology/tenant-123/"),
 * });
 *
 * // Wire into hexastore triple store
 * const app = KvTripleStoreLive.pipe(
 *   Layer.provide(layer),
 * );
 * ```
 */

import { Effect, Layer, Stream } from "effect";
import {
  KvBackend,
  type KvBackendService,
  type KvEntry,
  type KvTransaction,
  type RangeOptions,
} from "@open-ontology/database";

// ─── FDB imports (dynamic to allow graceful failure) ───────────────────────

// We import the types statically for type safety, but the actual module
// is loaded dynamically so the rest of the codebase can compile/run
// without libfdb_c installed.
import type FdbDatabase from "foundationdb/dist/lib/database.js";
import type FdbTransaction from "foundationdb/dist/lib/transaction.js";
import type { NativeValue } from "foundationdb/dist/lib/native.js";

// ─── Configuration ─────────────────────────────────────────────────────────

/**
 * Configuration for the FoundationDB KV backend.
 */
export interface FdbKvBackendConfig {
  /**
   * Path to the fdb.cluster file.
   * If omitted, uses the system default (usually /etc/foundationdb/fdb.cluster).
   */
  readonly clusterFile?: string;

  /**
   * Optional key prefix for isolation.
   * All keys are stored under this prefix, enabling multi-tenant or
   * multi-database isolation within a single FDB cluster.
   *
   * @example Buffer.from("ontology/my-database/")
   */
  readonly subspace?: Buffer;

  /**
   * FDB API version to use. Defaults to 720 (latest supported by the npm package).
   * Must match or be below the installed FDB server version.
   */
  readonly apiVersion?: number;

  /**
   * Maximum number of key-value entries per FDB transaction in `setAll`.
   * FDB has a 10MB transaction size limit; large bulk inserts must be
   * split across multiple transactions.
   *
   * Defaults to 5000 (~50 triples worth of hexastore index entries).
   * Tune lower if values are large, or higher if keys/values are small.
   */
  readonly maxTransactionEntries?: number;

  /**
   * Log retry attempts for FDB transactions (useful for large stress runs).
   * Logs to stderr with error code and retry count.
   */
  readonly logRetries?: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Convert Uint8Array to Buffer (FDB's native key type). Zero-copy when possible. */
const toBuffer = (u: Uint8Array): Buffer =>
  Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength);

/** Convert Buffer to Uint8Array. Zero-copy. */
const toUint8Array = (b: Buffer): Uint8Array =>
  new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** The zero byte — used as the start of the entire keyspace. */
const ZERO = Buffer.alloc(1, 0x00);

/** 0xFF byte — used as the end of the entire keyspace. */
const FF = Buffer.alloc(1, 0xff);

// ─── Range scan helper ─────────────────────────────────────────────────────

/**
 * Collect all key-value pairs from an FDB range scan into an array.
 * Uses getRangeAll for efficiency (single round-trip when possible).
 */
const collectRange = async (
  source: FdbDatabase<NativeValue, Buffer, NativeValue, Buffer>,
  options: RangeOptions,
): Promise<KvEntry[]> => {
  const start = toBuffer(options.start);
  const end = toBuffer(options.end);
  const rangeOptions: { limit?: number; reverse: boolean } = {
    reverse: options.reverse ?? false,
  };
  if (options.limit !== undefined) {
    rangeOptions.limit = options.limit;
  }
  const pairs = await source.getRangeAll(start, end, rangeOptions);
  return pairs.map(([k, v]) => [toUint8Array(k), toUint8Array(v)] as const);
};

/**
 * Collect range within a transaction context.
 */
const collectRangeTx = async (
  tx: FdbTransaction<NativeValue, Buffer, NativeValue, Buffer>,
  options: RangeOptions,
): Promise<KvEntry[]> => {
  const start = toBuffer(options.start);
  const end = toBuffer(options.end);
  const rangeOptions: { limit?: number; reverse: boolean } = {
    reverse: options.reverse ?? false,
  };
  if (options.limit !== undefined) {
    rangeOptions.limit = options.limit;
  }
  const pairs = await tx.getRangeAll(start, end, rangeOptions);
  return pairs.map(([k, v]) => [toUint8Array(k), toUint8Array(v)] as const);
};

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a FoundationDB KV backend.
 *
 * This function dynamically imports the `foundationdb` module and opens
 * a connection. If a subspace is configured, all operations are scoped
 * to that key prefix.
 *
 * @param config - Optional configuration (cluster file, subspace, API version)
 * @returns An Effect that produces a KvBackendService
 */
export const makeFdbKvBackendService = (
  config: FdbKvBackendConfig = {},
): Effect.Effect<KvBackendService> =>
  Effect.gen(function* () {
    // Dynamic import so the module compiles without libfdb_c installed
    const fdb = yield* Effect.tryPromise({
      try: () => import("foundationdb"),
      catch: (error) => new Error(`Failed to load foundationdb module: ${String(error)}`),
    }).pipe(Effect.orDie);

    // Set API version (must be called before any other FDB operation)
    fdb.setAPIVersion(config.apiVersion ?? 720);

    // Open database connection
    const rawDb = fdb.open(config.clusterFile);

    // Apply subspace prefix if configured
    const db = config.subspace ? rawDb.at(config.subspace) : rawDb;

    const logRetry = (label: string, attempt: number, err: unknown) => {
      if (!config.logRetries) return;
      const code = (err as { code?: number }).code;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  [FDB] ${label} retry #${attempt} (code ${code ?? "?"}: ${msg})\n`);
    };

    const runTransaction = <A>(
      label: string,
      body: (tx: FdbTransaction<NativeValue, Buffer, NativeValue, Buffer>) => Promise<A>,
    ): Effect.Effect<A> =>
      Effect.tryPromise({
        try: async () => {
          try {
            return await db.doTransaction(body);
          } catch (err) {
            logRetry(label, 1, err);
            throw err;
          }
        },
        catch: (e) => new Error(`FDB ${label} failed: ${String(e)}`),
      }).pipe(Effect.orDie);

    // ─── Service implementation ────────────────────────────────────────

    const service: KvBackendService = {
      get: (key) =>
        Effect.tryPromise({
          try: () => db.get(toBuffer(key)),
          catch: (e) => new Error(`FDB get failed: ${String(e)}`),
        }).pipe(
          Effect.map((val) => (val === undefined ? null : toUint8Array(val))),
          Effect.orDie,
        ),

      set: (key, value) =>
        Effect.tryPromise({
          try: () => db.set(toBuffer(key), toBuffer(value)),
          catch: (e) => new Error(`FDB set failed: ${String(e)}`),
        }).pipe(Effect.orDie),

      delete: (key) =>
        Effect.tryPromise({
          try: () => db.clear(toBuffer(key)),
          catch: (e) => new Error(`FDB delete failed: ${String(e)}`),
        }).pipe(Effect.orDie),

      getRange: (options) =>
        Stream.fromEffect(
          Effect.tryPromise({
            try: () => collectRange(db, options),
            catch: (e) => new Error(`FDB getRange failed: ${String(e)}`),
          }).pipe(Effect.orDie),
        ).pipe(Stream.flatMap(Stream.fromIterable)),

      transact: <A, E>(fn: (tx: KvTransaction) => Effect.Effect<A, E>) =>
        Effect.async<A, E>((resume) => {
          db.doTransaction(async (fdbTx) => {
            // Wrap the FDB transaction in a KvTransaction interface
            const kvTx: KvTransaction = {
              get: (key) =>
                Effect.tryPromise({
                  try: () => fdbTx.get(toBuffer(key)),
                  catch: (e) => new Error(`FDB tx.get failed: ${String(e)}`),
                }).pipe(
                  Effect.map((val) => (val === undefined ? null : toUint8Array(val))),
                  Effect.orDie,
                ),

              set: (key, value) =>
                Effect.sync(() => {
                  fdbTx.set(toBuffer(key), toBuffer(value));
                }),

              delete: (key) =>
                Effect.sync(() => {
                  fdbTx.clear(toBuffer(key));
                }),

              getRange: (rangeOpts) =>
                Stream.fromEffect(
                  Effect.tryPromise({
                    try: () => collectRangeTx(fdbTx, rangeOpts),
                    catch: (e) => new Error(`FDB tx.getRange failed: ${String(e)}`),
                  }).pipe(Effect.orDie),
                ).pipe(Stream.flatMap(Stream.fromIterable)),
            };

            // Execute the user's function within the FDB transaction
            const exit = await Effect.runPromiseExit(fn(kvTx));

            if (exit._tag === "Failure") {
              // Throw to abort the FDB transaction (triggers rollback)
              // We stash the exit so we can resume with it after doTransaction rejects.
              throw { __fdbKvRollback: true, exit };
            }

            return exit.value;
          }).then(
            (value) => resume(Effect.succeed(value as A)),
            (error) => {
              if (
                error !== null &&
                typeof error === "object" &&
                "__fdbKvRollback" in error &&
                error.__fdbKvRollback === true
              ) {
                // User-initiated rollback — resume with the original failure
                resume(Effect.failCause((error as any).exit.cause));
              } else {
                // Unexpected FDB error — die
                resume(Effect.die(new Error(`FDB transaction failed: ${String(error)}`)));
              }
            },
          );
        }) as Effect.Effect<A, E>,

      getMany: (keys) =>
        runTransaction("getMany", async (tx) => {
          // Fire all gets concurrently — FDB client batches them into
          // a single network round trip automatically.
          const bufKeys = keys.map(toBuffer);
          const values = await Promise.all(bufKeys.map((k) => tx.get(k)));
          return keys.map(
            (key, i) => [key, values[i] === undefined ? null : toUint8Array(values[i]!)] as const,
          );
        }),

      setAll: (entries) => {
        const maxEntries = config.maxTransactionEntries ?? 5000;
        if (entries.length <= maxEntries) {
          // Small batch: single transaction
          return runTransaction("setAll", async (tx) => {
            for (const [key, value] of entries) {
              tx.set(toBuffer(key), toBuffer(value));
            }
          });
        }
        // Large batch: chunk into multiple transactions
        return Effect.tryPromise({
          try: async () => {
            for (let i = 0; i < entries.length; i += maxEntries) {
              const chunk = entries.slice(i, i + maxEntries);
              await Effect.runPromise(
                runTransaction("setAll-chunk", async (tx) => {
                  for (const [key, value] of chunk) {
                    tx.set(toBuffer(key), toBuffer(value));
                  }
                }),
              );
            }
          },
          catch: (e) => new Error(`FDB setAll failed: ${String(e)}`),
        }).pipe(Effect.orDie);
      },

      clear: () =>
        Effect.tryPromise({
          try: () => db.clearRange(ZERO, FF),
          catch: (e) => new Error(`FDB clear failed: ${String(e)}`),
        }).pipe(Effect.orDie),

      // FDB is async-only — no sync fast paths are provided.
      // Optional properties are intentionally omitted (exactOptionalPropertyTypes).
    };

    return service;
  });

// ─── Effect Layer ──────────────────────────────────────────────────────────

/**
 * Create a Layer that provides KvBackend backed by FoundationDB.
 *
 * @param config - Optional FDB configuration
 * @returns Layer providing KvBackend
 *
 * @example
 * ```typescript
 * // Default local FDB
 * const layer = makeFdbKvBackend();
 *
 * // With subspace isolation
 * const layer = makeFdbKvBackend({
 *   subspace: Buffer.from("ontology/db1/"),
 * });
 *
 * // Full stack
 * const app = KvTripleStoreLive.pipe(
 *   Layer.provide(layer),
 * );
 * ```
 */
export const makeFdbKvBackend = (config?: FdbKvBackendConfig): Layer.Layer<KvBackend> =>
  Layer.effect(KvBackend, makeFdbKvBackendService(config));

/**
 * Default FDB KV backend layer.
 * Connects to the local FDB cluster with no subspace prefix.
 */
export const FdbKvBackendLive: Layer.Layer<KvBackend> = makeFdbKvBackend();
