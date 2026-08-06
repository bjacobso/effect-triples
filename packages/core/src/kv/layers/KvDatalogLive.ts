/**
 * KV-backed implementation of DatalogService.
 *
 * Adapts the KV Datalog executor to the DatalogService interface
 * expected by the rest of the system.
 */

import { Effect, Layer } from "effect";
import { Datalog, type DatalogService } from "../../datalog/service.js";
import { DatalogError, DatalogValidationError } from "../../errors/index.js";
import { KvBackend } from "../kv/KvBackend.js";
import { createKvTripleStore } from "../hexastore/KvTripleStore.js";
import { executeQuery, executeWrappedQuery } from "../datalog/executor.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import type { Context } from "../datalog/types.js";

// ─── Service implementation ────────────────────────────────────────────────

const makeKvDatalogService = Effect.gen(function* () {
  const kvBackend = yield* KvBackend;
  const hexaStore = createKvTripleStore(kvBackend);

  // Lazy-load validation schemas to avoid ESM resolution issues
  let validationModule: {
    validateQuery: (raw: unknown) => DatalogQuery | null;
    validateWrapped: (raw: unknown) => WrappedQuery | null;
  } | null = null;

  const getValidation = () => {
    if (validationModule) return validationModule;
    // Simple structural validation without Effect Schema dependency
    validationModule = {
      validateQuery: (raw: unknown): DatalogQuery | null => {
        if (typeof raw !== "object" || raw === null) return null;
        const obj = raw as Record<string, unknown>;
        if (!Array.isArray(obj["find"]) || !Array.isArray(obj["where"])) return null;
        return raw as DatalogQuery;
      },
      validateWrapped: (raw: unknown): WrappedQuery | null => {
        if (typeof raw !== "object" || raw === null) return null;
        const obj = raw as Record<string, unknown>;
        if (!obj["inner"] || typeof obj["inner"] !== "object") return null;
        const inner = obj["inner"] as Record<string, unknown>;
        if (!Array.isArray(inner["find"]) || !Array.isArray(inner["where"])) return null;
        return raw as WrappedQuery;
      },
    };
    return validationModule;
  };

  const service: DatalogService = {
    query: (rawQuery: unknown, debug?: boolean) => {
      const validation = getValidation();
      const query = validation.validateQuery(rawQuery);
      if (!query) {
        return Effect.fail(
          new DatalogValidationError({
            message: "Invalid Datalog query: missing find or where",
            query: rawQuery,
          }),
        );
      }

      return executeQuery(hexaStore, query).pipe(
        Effect.map((result) => {
          if (debug) {
            return {
              results: result.results as Context[],
              debug: {
                metrics: makeEmptyMetrics(query, 0),
                executionTimeMs: 0,
                resultCount: result.results.length,
                generatedSql: "(kv-store: no SQL generated)",
                params: [] as unknown[],
              },
            };
          }
          return { results: result.results as Context[] };
        }),
        Effect.mapError(
          (e) => new DatalogError({ message: `Query execution failed: ${String(e)}`, cause: e }),
        ),
      );
    },

    queryValidated: (query: DatalogQuery, debug?: boolean) =>
      executeQuery(hexaStore, query).pipe(
        Effect.map((result) => {
          if (debug) {
            return {
              results: result.results as Context[],
              debug: {
                metrics: makeEmptyMetrics(query, 0),
                executionTimeMs: 0,
                resultCount: result.results.length,
                generatedSql: "(kv-store: no SQL generated)",
                params: [] as unknown[],
              },
            };
          }
          return { results: result.results as Context[] };
        }),
        Effect.mapError(
          (e) => new DatalogError({ message: `Query execution failed: ${String(e)}`, cause: e }),
        ),
      ),

    queryWrapped: (query: WrappedQuery, _debug?: boolean) =>
      executeWrappedQuery(hexaStore, query).pipe(
        Effect.map((result) => ({
          results: result.results as Context[],
          ...(result.totalCount !== undefined ? { totalCount: result.totalCount } : {}),
          ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
        })),
        Effect.mapError(
          (e) => new DatalogError({ message: `Wrapped query failed: ${String(e)}`, cause: e }),
        ),
      ),

    explain: (rawQuery: unknown) => {
      const validation = getValidation();
      const query = validation.validateQuery(rawQuery);
      if (!query) {
        return Effect.fail(
          new DatalogValidationError({
            message: "Invalid Datalog query",
            query: rawQuery,
          }),
        );
      }

      return Effect.succeed({
        queryPlan: {
          backend: "kv-store" as const,
          steps: [{ label: "main", query: JSON.stringify(query, null, 2) }],
        },
        metrics: makeEmptyMetrics(query, 0),
      });
    },

    explainWrapped: (rawQuery: unknown) => {
      const validation = getValidation();
      const query = validation.validateWrapped(rawQuery);
      if (!query) {
        return Effect.fail(
          new DatalogValidationError({
            message: "Invalid wrapped query",
            query: rawQuery,
          }),
        );
      }

      return Effect.succeed({
        queryPlan: {
          backend: "kv-store" as const,
          steps: [{ label: "main", query: JSON.stringify(query, null, 2) }],
        },
      });
    },
  };

  return service;
});

// ─── Helpers ───────────────────────────────────────────────────────────────

const makeEmptyMetrics = (query: DatalogQuery, compilationTimeMs: number) => ({
  joinCount: 0,
  whereConditionCount: query.where.length,
  subqueryCount: 0,
  cteCount: 0,
  sqlLength: 0,
  paramCount: 0,
  patternCount: query.where.filter((c) => Array.isArray(c) && c.length >= 3 && c.length <= 4)
    .length,
  predicateCount: query.where.filter(
    (c) => Array.isArray(c) && [">", ">=", "<", "<=", "=", "!="].includes(c[0] as string),
  ).length,
  notClauseCount: query.where.filter((c) => Array.isArray(c) && c[0] === "not").length,
  orClauseCount: query.where.filter((c) => Array.isArray(c) && c[0] === "or").length,
  linkClauseCount: query.where.filter((c) => Array.isArray(c) && c[0] === "link").length,
  hasAggregation: (query.aggregate?.length ?? 0) > 0,
  isRecursive: false,
  aggregateOps: (query.aggregate ?? []).map((a) => a[0]),
  compilationTimeMs,
});

// ─── Layer ─────────────────────────────────────────────────────────────────

/**
 * Layer that provides DatalogService backed by the KV executor.
 * Requires KvBackend.
 */
export const KvDatalogLive: Layer.Layer<Datalog, never, KvBackend> = Layer.effect(
  Datalog,
  makeKvDatalogService,
) as unknown as Layer.Layer<Datalog, never, KvBackend>;
