/**
 * Unified database package.
 *
 * Owns the collapsed public database surface.
 * SQL-bound code (layers, migrations, storage backends) lives in @open-ontology/database-sql.
 */

export * from "./Branded.js";
export * from "./Database.js";
export * from "./DatabaseApi.js";
export * from "./DatabaseRpc.js";
export * from "./DatalogApi.js";
export * from "./DatalogRpc.js";
export * from "./Error.js";
export * from "./Snapshot.js";
export * from "./SnapshotApi.js";
export * from "./Triple.js";
export * from "./TripleApi.js";
export * from "./TripleRpc.js";
export * from "./Value.js";
export * from "./errors/index.js";
export * from "./types/Pattern.js";
export * from "./types/Filter.js";
export { type QueryState, type QueryOperator, Query } from "./types/QueryBuilder.js";
export { StorageAdapter, type StorageAdapterService } from "./storage/StorageAdapter.js";
export { type QueryPattern, type TransactionInfo } from "./storage/types.js";
export { generateId, generateTransactionId, TxAttributes, SystemPrefixes } from "./utils/id.js";
export {
  type QueryDependencies,
  type SyncClientMessage,
  type SyncServerMessage,
  type SyncSubscribeMessage,
  type SyncUnsubscribeMessage,
  type SyncConnectedMessage,
  type SyncChangesMessage,
  type SyncSubscribedMessage,
  type SyncErrorMessage,
  type SyncPongMessage,
  type InvalidationResult,
  type Subscription,
  type AffectedSubscriptions,
  extractDependencies,
  extractEntityType,
  checkInvalidation,
  isAffectedByChange,
  hashQuery,
  TopicTree,
  TopicFilteredSyncHub,
  SubscriptionManager,
  makeSubscriptionManager,
  SubscriptionManagerLive,
  type SubscriptionManagerService,
  type SyncAttachedQuery,
  type SyncConnection,
  type SyncHubMessageHooks,
} from "./subscriptions/index.js";

export {
  Variable,
  DatalogAttribute,
  Constant,
  Term,
  PredicateOp,
  PatternClause,
  PredicateClause,
  NotClause,
  OrClause,
  LinkClause,
  Clause,
  AggregateOp,
  AggregateSpec,
  OrderBySpec,
  HavingClause,
  DatalogQuery,
  WrapperFilterOp,
  WrapperFilter,
  WrappedQuery,
  RuleApplication,
  Rule,
  isVariable,
  isAttribute,
  isPredicateClause,
  isPatternClause,
  isNotClause,
  isOrClause,
  isLinkClause,
  isRuleApplication,
  isTypedConstant,
} from "./datalog/schema.js";

export type { Context, QueryResult, SimplifiedTriple, Binding } from "./datalog/types.js";
export { emptyContext } from "./datalog/types.js";

export {
  TripleStore,
  type TripleStoreService,
  type TransactionResult,
  type TransactionMeta,
  type BulkInsertOptions,
} from "./store/TripleStore.js";
export { TripleStoreLive, TripleStoreAdapterLive } from "./store/TripleStoreAdapterLayer.js";
export {
  DatabaseManager,
  type DatabaseManagerService,
  type Database,
  type ClearResult,
} from "./store/DatabaseManager.js";
export {
  DatabaseRegistry,
  type DatabaseRegistryService,
  type DatabaseAccessEntry,
} from "./store/DatabaseRegistry.js";
export {
  ChangeEmitter,
  type ChangeEmitterService,
  type ChangeEvent,
  type TripleChange,
  NoopChangeEmitter,
  NoopChangeEmitterLive,
} from "./store/ChangeEmitter.js";
export {
  CapabilityError,
  type StoreCapability,
  validateDependencies,
  composeStore,
  describeCapabilities,
} from "./store/StoreCapability.js";
export { makeWriteInterceptors, type WriteEventCallback } from "./store/writeEventUtils.js";
export { makeChangeEmissionCapability } from "./store/ChangeEmissionCapability.js";
export {
  PostMutationHook,
  type PostMutationHookService,
  NoopPostMutationHook,
  NoopPostMutationHookLive,
} from "./store/PostMutationHook.js";
export {
  RuntimeClock,
  type RuntimeClockService,
  RuntimeClockLive,
  DeterministicRuntimeClockLive,
  IdGenerator,
  type IdGeneratorService,
  IdGeneratorLive,
  DeterministicIdGeneratorLive,
  RuntimeServicesLive,
  DeterministicRuntimeServicesLive,
  type DeterministicRuntimeOptions,
} from "./store/RuntimeServices.js";
export {
  TripleStoreRuntime,
  type TripleStoreRuntimeService,
  TripleStoreRuntimeLive,
  TripleStoreRuntimeFromServicesLive,
  TripleStoreRuntimeLayer,
  getTripleStoreRuntime,
  DeterministicTripleStoreRuntimeLive,
  type DeterministicTripleStoreRuntimeOptions,
} from "./store/TripleStoreRuntime.js";
export { DatabaseFeatures, type DatabaseFeature } from "./store/DatabaseFeatures.js";

// =============================================================================
// Snapshots
// =============================================================================

export {
  SnapshotService,
  SnapshotWriter,
  type SnapshotServiceShape,
  type SnapshotWriterShape,
  SnapshotError,
} from "./snapshots/SnapshotService.js";
export { SnapshotServiceLive, SnapshotWriterLive } from "./snapshots/SnapshotServiceLive.js";
export { makeEntitySnapshotsCapability } from "./snapshots/EntitySnapshotsCapability.js";
export {
  type EntitySnapshot,
  type EntityDiff,
  type SnapshotValue,
  type SnapshotAttributeMap,
  canonicalize,
  hashCanonical,
  triplesToAttributeMap,
  tripleValueToSnapshotValue,
  EMPTY_ENTITY_HASH,
  diffAttributes,
} from "./snapshots/canonical.js";
export { wrapStoreWithSnapshots } from "./snapshots/wrapStoreWithSnapshots.js";

export {
  Datalog,
  type DatalogService,
  type QueryPlan,
  type QueryDebugInfo,
  type WrappedQueryResult,
} from "./datalog/service.js";
export {
  QueryExecutor,
  type QueryExecutorService,
  type QueryContext,
  type QueryMetrics as QueryExecutorMetrics,
} from "./storage/QueryExecutor.js";

export {
  compile,
  compileToSql,
  compileWithRules,
  compileWithRulesToSql,
  type CompiledQuery,
  type DatalogQueryWithRules,
  type QueryMetrics,
} from "./datalog/compiler.js";
export { compileWrapped, type CompiledWrappedQuery } from "./datalog/wrapper.js";
export {
  matchPattern,
  querySingle,
  queryWhere,
  actualize,
  query,
  querySync,
} from "./datalog/engine.js";
export {
  resolveTerm,
  resolveTermSync,
  evaluatePredicate,
  evaluatePredicateSync,
} from "./datalog/predicates.js";
// NOTE: toDatalogQuery (QueryPlan->DatalogQuery) lives in core -- it's a compiler concern.
// NOTE: typeCheckDatalogQuery lives in core -- it depends on HM types from the lisp package.
export { type SqlDialect, CurrentDialect, SqliteDialect } from "./dialects/index.js";
export { createParamCollector, type ParamCollector } from "./params.js";

export {
  Sparql,
  type SparqlService,
  type QueryDebugInfo as SparqlQueryDebugInfo,
} from "./sparql/service.js";
export {
  type Context as SparqlContext,
  type SelectResult,
  type ResultTriple,
  type ConstructResult,
  type DescribeResult,
  type AskResult,
  type QueryResult as SparqlQueryResult,
} from "./sparql/types.js";
export { SparqlQuery } from "./sparql/schema.js";
export {
  compile as compileSparql,
  compileToSql as compileSparqlToSql,
  type CompiledQuery as SparqlCompiledQuery,
  type QueryMetrics as SparqlQueryMetrics,
} from "./sparql/compiler.js";
export {
  isVariable as isSparqlVariable,
  isIRI,
  isTriplePattern,
  isOptionalPattern,
  isUnionPattern,
  isFilterPattern,
  isBindPattern,
  isValuesPattern,
  isMinusPattern,
  isPropertyPathPattern,
  isSubSelectPattern,
} from "./sparql/schema.js";

// =============================================================================
// KV Backend + Hexastore
// =============================================================================

export {
  KvBackend,
  type KvBackendService,
  type KvEntry,
  type KvTransaction,
  type RangeOptions,
} from "./kv/kv/KvBackend.js";
export { InMemoryKvBackendLive, makeTestKvBackend } from "./kv/kv/InMemoryKvBackend.js";
export { compare, increment, concat, fromHex, toHex, startsWith } from "./kv/kv/encoding.js";

export {
  type TuplePart,
  encodeTuple,
  decodeTuple,
  tNull,
  tBoolean,
  tNumber,
  tString,
  tRef,
  tDatetime,
  tJson,
  tBlob,
  tMax,
  TAG_NULL,
  TAG_BOOLEAN,
  TAG_NUMBER,
  TAG_STRING,
  TAG_REF,
  TAG_DATETIME,
  TAG_JSON,
  TAG_BLOB,
  TAG_MAX,
} from "./kv/hexastore/tuple.js";

export {
  type IndexName,
  type PatternShape,
  type IndexChoice,
  EAVT_PREFIX,
  AEVT_PREFIX,
  AVET_PREFIX,
  VAET_PREFIX,
  META_PREFIX,
  INDEX_PREFIX,
  eavtKey,
  aevtKey,
  avetKey,
  vaetKey,
  metaKey,
  selectIndex,
  prefixRange,
} from "./kv/hexastore/indexes.js";

export { type ScanPattern, valueToTuplePart, patternToScan } from "./kv/hexastore/scan.js";
export { type Datom, KvTripleStore, createKvTripleStore } from "./kv/hexastore/KvTripleStore.js";

export {
  tripleValueToConstant,
  constantToTripleValue,
  bindDatom,
  executePattern,
  patternToScanPattern,
} from "./kv/datalog/pattern.js";
export {
  evaluatePredicate as kvEvaluatePredicate,
  filterByPredicate,
  resolveTerm as kvResolveTerm,
} from "./kv/datalog/predicate.js";
export {
  type QueryResult as KvQueryResult,
  type WrappedQueryResult as KvWrappedQueryResult,
  executeQuery as executeKvQuery,
  executeWrappedQuery as executeKvWrappedQuery,
} from "./kv/datalog/executor.js";

export { KvTripleStoreLive } from "./kv/layers/KvTripleStoreLive.js";
export { KvDatalogLive } from "./kv/layers/KvDatalogLive.js";
