import { Context, Effect, Layer } from "effect";
import { TransactionId, TripleId, type TransactionId as TransactionIdType } from "../Branded.js";
import { generateId, generateTransactionId } from "../utils/id.js";

export interface RuntimeClockService {
  readonly now: Effect.Effect<number>;
}

export class RuntimeClock extends Context.Service<RuntimeClock, RuntimeClockService>()(
  "RuntimeClock",
) {}

export const RuntimeClockLive = Layer.succeed(RuntimeClock, {
  now: Effect.sync(() => Date.now()),
} satisfies RuntimeClockService);

export interface IdGeneratorService {
  readonly generate: (scope: string) => Effect.Effect<string>;
  readonly nextId: (scope: string) => Effect.Effect<string>;
  readonly nextTripleId: Effect.Effect<TripleId>;
  readonly nextTxId: Effect.Effect<TransactionIdType>;
}

export class IdGenerator extends Context.Service<IdGenerator, IdGeneratorService>()(
  "IdGenerator",
) {}

export const IdGeneratorLive = Layer.succeed(IdGenerator, {
  generate: (scope) => Effect.sync(() => `${scope}/${generateId()}`),
  nextId: (scope) => Effect.sync(() => `${scope}/${generateId()}`),
  nextTripleId: Effect.sync(() => generateId()),
  nextTxId: Effect.sync(() => generateTransactionId()),
} satisfies IdGeneratorService);

export interface DeterministicRuntimeOptions {
  readonly now: number;
  readonly idSeed?: string;
}

export const DeterministicRuntimeClockLive = ({ now }: Pick<DeterministicRuntimeOptions, "now">) =>
  Layer.succeed(RuntimeClock, {
    now: Effect.succeed(now),
  } satisfies RuntimeClockService);

export const DeterministicIdGeneratorLive = ({
  idSeed = "e2e",
}: Pick<DeterministicRuntimeOptions, "idSeed">) =>
  Layer.sync(IdGenerator, () => {
    const seed = idSeed.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
    const counters = new Map<string, number>();

    const next = (scope: string) =>
      Effect.sync(() => {
        const current = counters.get(scope) ?? 0;
        const nextValue = current + 1;
        counters.set(scope, nextValue);
        return `${scope}/${seed}-${String(nextValue).padStart(6, "0")}`;
      });

    const deterministicUlid = (scope: string, value: number) => {
      let hash = 2_166_136_261;
      for (const character of `${seed}:${scope}`) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16_777_619);
      }
      const prefix = (hash >>> 0).toString(36).toUpperCase().padStart(8, "0");
      const counter = value.toString(36).toUpperCase().padStart(18, "0");
      return `${prefix}${counter}`;
    };

    let tripleCounter = 0;
    let transactionCounter = 0;

    return {
      generate: next,
      nextId: next,
      nextTripleId: Effect.sync(() => TripleId.make(deterministicUlid("triple", ++tripleCounter))),
      nextTxId: Effect.sync(() =>
        TransactionId.make(`_tx/${deterministicUlid("transaction", ++transactionCounter)}`),
      ),
    } satisfies IdGeneratorService;
  });

export const RuntimeServicesLive = Layer.mergeAll(RuntimeClockLive, IdGeneratorLive);

export const DeterministicRuntimeServicesLive = (options: DeterministicRuntimeOptions) =>
  Layer.mergeAll(DeterministicRuntimeClockLive(options), DeterministicIdGeneratorLive(options));
