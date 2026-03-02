/**
 * Structured benchmark results for report generation.
 *
 * Written to `benchmark-results-{backend}.json` by the stress test
 * when STRESS_JSON_OUTPUT=true is set.
 */

export interface BenchmarkResults {
  readonly backend: string;
  readonly employeeCount: number;
  readonly updateRounds: number;
  readonly timestamp: string;
  readonly system: {
    readonly platform: string;
    readonly arch: string;
    readonly cpus: number;
    readonly cpuModel: string;
    readonly totalMemoryGB: number;
    readonly nodeVersion: string;
  };
  insertion: InsertionMetrics | null;
  updates: UpdateMetrics | null;
  readonly queries: QueryMetric[];
}

export interface InsertionMetrics {
  readonly totalTriples: number;
  readonly generationTimeMs: number;
  readonly insertionTimeMs: number;
  readonly throughputTriplesPerSec: number;
  readonly avgBatchMs: number;
  readonly minBatchMs: number;
  readonly maxBatchMs: number;
  readonly variance: number;
  readonly databaseSize: string;
}

export interface UpdateMetrics {
  readonly rounds: number;
  readonly attributesPerUpdate: number;
  readonly totalUpdates: number;
  readonly totalTimeMs: number;
  readonly overallThroughputUpdatesPerSec: number;
  readonly perRound: RoundMetrics[];
  readonly databaseSizeAfter: string;
}

export interface RoundMetrics {
  readonly round: number;
  readonly timeMs: number;
  readonly throughputUpdatesPerSec: number;
  readonly avgBatchMs: number;
  readonly minBatchMs: number;
  readonly maxBatchMs: number;
}

export interface QueryMetric {
  readonly id: string;
  readonly description: string;
  readonly durationMs: number;
  readonly resultCount: number;
}
