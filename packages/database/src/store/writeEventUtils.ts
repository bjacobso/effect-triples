/**
 * writeEventUtils — shared helpers for building ChangeEvents from write operations.
 *
 * Both ChangeEmissionCapability and ReactiveConstraintsCapability need to intercept
 * writes, build ChangeEvent objects, and invoke callbacks. This module extracts
 * the common logic so it isn't duplicated across capabilities.
 *
 * @see specs/core/composable-store.md
 */

import { Effect, Option, pipe } from "effect";
import type { TripleStoreService } from "./TripleStore.js";
import type { ChangeEvent, TripleChange } from "./ChangeEmitter.js";

// =============================================================================
// Write Interceptor
// =============================================================================

/**
 * Callback invoked after each successful write operation.
 * Receives the ChangeEvent describing what changed.
 * The callback's return value is awaited but errors should be handled
 * by the caller (typically caught and swallowed).
 */
export type WriteEventCallback = (event: ChangeEvent) => Effect.Effect<void>;

/**
 * Create write-side methods for a TripleStoreService that intercept every
 * mutation, delegate to the inner store, build a ChangeEvent, and invoke
 * the callback. Read operations are NOT included — callers should spread
 * the inner store's read methods directly.
 *
 * Pre-fetches triple info for retract-by-ID operations so the ChangeEvent
 * includes correct entityId/attribute even after the triple is removed.
 */
export const makeWriteInterceptors = (
  inner: TripleStoreService,
  onEvent: WriteEventCallback,
  now: Effect.Effect<number>,
): Pick<
  TripleStoreService,
  "assert" | "assertBatch" | "retract" | "retractByPattern" | "transact"
> => ({
  assert: (input) =>
    pipe(
      inner.assert(input),
      Effect.tap((triple) =>
        onEvent({
          txId: Option.getOrElse(triple.txId, () => ""),
          timestamp: triple.createdAt,
          changes: [
            { operation: "assert" as const, entityId: input.entityId, attribute: input.attribute },
          ],
        }),
      ),
    ),

  assertBatch: (inputs, options) =>
    pipe(
      inner.assertBatch(inputs, options),
      Effect.tap((triples) => {
        return Effect.gen(function* () {
          const changes: TripleChange[] = inputs.map((input) => ({
            operation: "assert" as const,
            entityId: input.entityId,
            attribute: input.attribute,
          }));
          const first = triples[0];
          return yield* onEvent({
            txId: first ? Option.getOrElse(first.txId, () => "") : "",
            timestamp: first?.createdAt ?? (yield* now),
            changes,
          });
        });
      }),
    ),

  retract: (id) =>
    pipe(
      inner.getTriple(id),
      Effect.catchAll(() => Effect.succeed(null)),
      Effect.flatMap((triple) =>
        pipe(
          inner.retract(id),
          Effect.tap(() =>
            Effect.gen(function* () {
              return yield* onEvent({
                txId: "",
                timestamp: yield* now,
                changes: [
                  {
                    operation: "retract" as const,
                    entityId: triple?.entityId ?? "",
                    attribute: triple?.attribute ?? "",
                  },
                ],
              });
            }),
          ),
        ),
      ),
    ),

  retractByPattern: (pattern) =>
    pipe(
      inner.retractByPattern(pattern),
      Effect.tap(() =>
        Effect.gen(function* () {
          return yield* onEvent({
            txId: "",
            timestamp: yield* now,
            changes: [
              {
                operation: "retract" as const,
                entityId: typeof pattern.entityId === "string" ? pattern.entityId : "",
                attribute: typeof pattern.attribute === "string" ? pattern.attribute : "",
              },
            ],
          });
        }),
      ),
    ),

  transact: (operations, meta) =>
    Effect.gen(function* () {
      // Pre-fetch triples for retract-by-ID ops to resolve entityId/attribute
      const tripleMap = new Map<string, { entityId: string; attribute: string }>();
      for (const op of operations) {
        if (op.op === "retract") {
          const triple = yield* inner
            .getTriple(op.id as any)
            .pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (triple) {
            tripleMap.set(op.id, { entityId: triple.entityId, attribute: triple.attribute });
          }
        }
      }

      const result = yield* inner.transact(operations, meta);

      const changes: TripleChange[] = [];
      for (const op of operations) {
        if (op.op === "assert") {
          changes.push({
            operation: "assert" as const,
            entityId: op.entityId,
            attribute: op.attribute,
          });
        } else if (op.op === "retract") {
          const info = tripleMap.get(op.id);
          changes.push({
            operation: "retract" as const,
            entityId: info?.entityId ?? "",
            attribute: info?.attribute ?? "",
          });
        } else if (op.op === "retract-pattern") {
          changes.push({
            operation: "retract" as const,
            entityId: typeof op.pattern.entityId === "string" ? op.pattern.entityId : "",
            attribute: typeof op.pattern.attribute === "string" ? op.pattern.attribute : "",
          });
        }
      }

      const event: ChangeEvent = { txId: result.txId, timestamp: yield* now, changes };
      yield* onEvent(event);

      return result;
    }),
});
