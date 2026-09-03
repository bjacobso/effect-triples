import { Context, Effect, Layer } from "effect";
import {
  DeterministicRuntimeServicesLive,
  IdGenerator,
  IdGeneratorLive,
  RuntimeClock,
  RuntimeClockLive,
  type DeterministicRuntimeOptions,
} from "./RuntimeServices.js";
import type { TransactionId, TripleId } from "../Branded.js";
import { generateId, generateTransactionId } from "../utils/id.js";

export interface TripleStoreRuntimeService {
  /** Stable identity used to prevent opaque cursors crossing database boundaries. */
  readonly scope: string;
  readonly now: Effect.Effect<number>;
  readonly nextTripleId: Effect.Effect<TripleId>;
  readonly nextTxId: Effect.Effect<TransactionId>;
}

export class TripleStoreRuntime extends Context.Service<
  TripleStoreRuntime,
  TripleStoreRuntimeService
>()("TripleStoreRuntime") {}

export const TripleStoreRuntimeLive = Layer.succeed(TripleStoreRuntime, {
  scope: "default",
  now: Effect.sync(() => Date.now()),
  nextTripleId: Effect.sync(() => generateId()),
  nextTxId: Effect.sync(() => generateTransactionId()),
} satisfies TripleStoreRuntimeService);

export const TripleStoreRuntimeFromServicesLive = Layer.effect(
  TripleStoreRuntime,
  Effect.gen(function* () {
    const clock = yield* RuntimeClock;
    const ids = yield* IdGenerator;
    return {
      scope: "default",
      now: clock.now,
      nextTripleId: ids.nextTripleId,
      nextTxId: ids.nextTxId,
    } satisfies TripleStoreRuntimeService;
  }),
);

export const TripleStoreRuntimeLayer = TripleStoreRuntimeFromServicesLive.pipe(
  Layer.provide(RuntimeClockLive),
  Layer.provide(IdGeneratorLive),
);

/** Construct the standard runtime with a stable database cursor scope. */
export const makeTripleStoreRuntimeLayer = (scope: string) =>
  Layer.effect(
    TripleStoreRuntime,
    Effect.gen(function* () {
      const clock = yield* RuntimeClock;
      const ids = yield* IdGenerator;
      return {
        scope,
        now: clock.now,
        nextTripleId: ids.nextTripleId,
        nextTxId: ids.nextTxId,
      } satisfies TripleStoreRuntimeService;
    }),
  ).pipe(Layer.provide(RuntimeClockLive), Layer.provide(IdGeneratorLive));

export const getTripleStoreRuntime = TripleStoreRuntime;

export type DeterministicTripleStoreRuntimeOptions = DeterministicRuntimeOptions;

export const DeterministicTripleStoreRuntimeLive = (options: DeterministicRuntimeOptions) =>
  TripleStoreRuntimeFromServicesLive.pipe(Layer.provide(DeterministicRuntimeServicesLive(options)));
