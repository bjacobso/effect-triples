/**
 * FoundationDB backend for the database KV layer.
 *
 * Isolates the `foundationdb` native dependency so consumers that
 * don't need FDB don't pull it in.
 */

export {
  FdbKvBackendLive,
  FdbKvBackendError,
  assertFdbSubspaceConfigured,
  classifyFdbError,
  makeFdbKvBackend,
  makeFdbKvBackendService,
  type FdbKvBackendErrorKind,
  type FdbKvBackendConfig,
  type FdbTransactionMetrics,
} from "./FdbKvBackend.js";
export {
  FdbSubscriptions,
  fdbSubscriptionAttributeKey,
  fdbSubscriptionEntityKey,
  fdbSubscriptionEntityTypeKey,
  fdbSubscriptionGlobalKey,
  fdbSubscriptionKeysForDependencies,
  fdbSubscriptionKeysForEvent,
  fdbSubscriptionLinkTypeKey,
  makeFdbChangeEmitter,
  makeFdbChangeEmitterService,
  makeFdbSubscriptionService,
  makeFdbSubscriptions,
  type FdbSubscriptionHandle,
  type FdbSubscriptionService,
  type FdbSubscriptionWatchOptions,
} from "./FdbSubscriptions.js";
