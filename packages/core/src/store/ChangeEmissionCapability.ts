/**
 * ChangeEmission capability — emits ChangeEvents after every write operation.
 *
 * Responsibility: broadcast change events to the ChangeEmitter (e.g., for
 * WebSocket fanout to connected clients).
 *
 * Priority: 50 (inside EntitySnapshots at 60)
 * Requires: none
 */

import { Effect } from "effect";
import type { StoreCapability } from "./StoreCapability.js";
import type { TriplesService } from "./Triples.js";
import type { ChangeEmitterService } from "./ChangeEmitter.js";
import { makeWriteInterceptors } from "./writeEventUtils.js";

/**
 * Create a ChangeEmission capability.
 *
 * The capability is parameterized by the emitter at creation time (resolved
 * from the Effect context in DatabaseManagerLayer), rather than requiring it
 * in the `StoreCapability.wrap` signature. This keeps the `StoreCapability`
 * interface simple and synchronous.
 */
export const makeChangeEmissionCapability = (
  emitter: ChangeEmitterService,
  now: Effect.Effect<number>,
): StoreCapability => ({
  name: "ChangeEmission",
  priority: 50,
  requires: [],
  wrap: (store: TriplesService): TriplesService => {
    const safeEmit = makeWriteInterceptors(
      store,
      (event) => emitter.emit(event).pipe(Effect.catchCause(() => Effect.void)),
      now,
    );

    return {
      ...store,
      // Write operations — emit after success
      ...safeEmit,
    };
  },
});
