// Types and canonical functions
export {
  type SnapshotValue,
  type SnapshotAttributeMap,
  type EntitySnapshot,
  type EntityDiff,
  CANONICAL_VERSION,
  FORMAT_VERSION,
  EMPTY_ENTITY_HASH,
  tripleValueToSnapshotValue,
  triplesToAttributeMap,
  canonicalize,
  hashCanonical,
  diffAttributes,
} from "./canonical.js";

// Service interfaces and tags
export {
  SnapshotService,
  SnapshotWriter,
  SnapshotError,
  type SnapshotServiceShape,
  type SnapshotWriterShape,
} from "./SnapshotService.js";

// Layer implementations
export { SnapshotServiceLive, SnapshotWriterLive } from "./SnapshotServiceLive.js";

// StoreCapability (composable capability interface)
export { makeEntitySnapshotsCapability } from "./EntitySnapshotsCapability.js";
