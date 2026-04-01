import { Context, Layer } from "effect";
import { generateTransactionId } from "../utils/id.js";

export interface TripleStoreRuntimeService {
  readonly now: () => number;
  readonly nextTxId: () => string;
}

export class TripleStoreRuntime extends Context.Tag("TripleStoreRuntime")<
  TripleStoreRuntime,
  TripleStoreRuntimeService
>() {}

export const TripleStoreRuntimeLive = Layer.succeed(TripleStoreRuntime, {
  now: () => Date.now(),
  nextTxId: () => generateTransactionId(),
} satisfies TripleStoreRuntimeService);
