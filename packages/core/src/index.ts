/**
 * Unified database package.
 *
 * Owns the collapsed public database surface.
 * SQL-bound code (layers, migrations, storage backends) lives in @bjacobso/triplex-sql.
 */

export * from "./Branded.js";
export * from "./Database.js";
export * from "./Error.js";
export * from "./Snapshot.js";
export * from "./Triple.js";
export * from "./Value.js";
export * from "./errors/index.js";
export * from "./types/Pattern.js";
export * from "./types/Filter.js";
export { type QueryState, type QueryOperator, Query } from "./types/QueryBuilder.js";
export {
  type Subscription,
  type AffectedSubscriptions,
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
  OrAlternative,
  OrClause,
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
  isRuleApplication,
  isTypedConstant,
  normalizeOrAlternatives,
} from "./datalog/schema.js";

export type { Context, QueryResult } from "./datalog/types.js";

export {
  Triples,
  type TriplesService,
  type TransactionResult,
  type TransactionMeta,
  type TransactionChange,
  type TransactionRecord,
  type TransactionPageRequest,
  type TransactionPage,
  type BulkInsertOptions,
  type QueryOptions,
  type QueryResponse,
  type PagedQueryResponse,
  type ExplainResult,
} from "./store/Triples.js";
export {
  DatabaseManager,
  type DatabaseManagerService,
  type Database,
  type ClearResult,
} from "./store/DatabaseManager.js";

// =============================================================================
// Snapshots
// =============================================================================

export {
  SnapshotService,
  type SnapshotServiceShape,
  SnapshotError,
} from "./snapshots/SnapshotService.js";
export {
  type EntitySnapshot,
  type EntityDiff,
  type SnapshotValue,
  type SnapshotAttributeMap,
} from "./snapshots/canonical.js";
export { KvTriples } from "./kv/layers/KvTriplesLive.js";
