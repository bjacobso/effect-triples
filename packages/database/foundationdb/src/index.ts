/**
 * FoundationDB backend for the database KV layer.
 *
 * Isolates the `foundationdb` native dependency so consumers that
 * don't need FDB don't pull it in.
 */

export {
  FdbKvBackendLive,
  makeFdbKvBackend,
  makeFdbKvBackendService,
  type FdbKvBackendConfig,
} from "./FdbKvBackend.js";
