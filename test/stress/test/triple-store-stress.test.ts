import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import { string, boolean, ref } from "@open-ontology/core";
import type { EntityId, BulkInsertOptions } from "@open-ontology/core";
import { generateEmployeeTriples } from "../src/data-generator.js";
import {
  getBackendName,
  getEmployeeCount,
  makeTestLayer,
  getThresholds,
  cleanupBefore,
  cleanupAfter,
  getDatabaseSize,
  describeBackend,
  supportsBulkOptions,
  getStoreAndDatalog,
} from "../src/backend.js";

// ============================================================================
// Backend Configuration
// ============================================================================

const BACKEND = getBackendName();
const EMPLOYEE_COUNT = getEmployeeCount();
const BATCH_SIZE = 1_000; // Employees per batch
const TRIPLES_PER_EMPLOYEE = 10; // Average (9 core + ~20% have 10th manager attribute)
const TestLayer = makeTestLayer(BACKEND);
const thresholds = getThresholds(BACKEND);

// ============================================================================
// SQLite-specific Optimization Flags
// ============================================================================
// STRESS_DROP_INDEXES=true     - Drop indexes during bulk insert (3-5x speedup, SQLite only)
// STRESS_UNSAFE_MODE=true      - Use unsafe PRAGMA settings (1.2-2x speedup, SQLite only)
// STRESS_TEST_KEEP_DB=true     - Keep database after test for inspection
// STRESS_BACKEND=sqlite|pg     - Backend to test (default: sqlite)
// STRESS_EMPLOYEE_COUNT=N      - Number of employees to generate (default: 100000)
// DATABASE_URL=...             - PostgreSQL connection URL (required for pg backend)
// ============================================================================

const DROP_INDEXES = process.env["STRESS_DROP_INDEXES"] === "true";
const UNSAFE_MODE = process.env["STRESS_UNSAFE_MODE"] === "true";

const BULK_OPTIONS: BulkInsertOptions = {
  dropIndexes: DROP_INDEXES,
  unsafeMode: UNSAFE_MODE,
};

// Log configuration at test start
const sqliteOpts = supportsBulkOptions(BACKEND)
  ? [DROP_INDEXES ? "dropIndexes" : null, UNSAFE_MODE ? "unsafeMode" : null]
      .filter(Boolean)
      .join(", ") || "default (no optimizations)"
  : "N/A (not SQLite)";

process.stderr.write(`\n  Backend: ${describeBackend(BACKEND)}\n`);
process.stderr.write(`  Employees: ${EMPLOYEE_COUNT.toLocaleString()}\n`);
process.stderr.write(`  SQLite options: ${sqliteOpts}\n`);

// ============================================================================
// Tests
// ============================================================================

describe(`Triple Store Stress Test [${BACKEND}] - ${(EMPLOYEE_COUNT * TRIPLES_PER_EMPLOYEE).toLocaleString()} Triples`, () => {
  beforeAll(async () => {
    await cleanupBefore(BACKEND);
  });

  it("should insert triples efficiently", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store } = yield* getStoreAndDatalog();

        // Generate all triples upfront
        process.stderr.write(
          `\n  Generating ${EMPLOYEE_COUNT.toLocaleString()} employees (~${(EMPLOYEE_COUNT * TRIPLES_PER_EMPLOYEE).toLocaleString()} triples)...\n`,
        );
        const startGen = Date.now();
        const allTriples = generateEmployeeTriples(EMPLOYEE_COUNT);
        const genTime = Date.now() - startGen;
        process.stderr.write(`  Generation: ${genTime}ms (${(genTime / 1000).toFixed(2)}s)\n\n`);

        // Insert in batches
        process.stderr.write(
          `  Inserting in ${Math.ceil(EMPLOYEE_COUNT / BATCH_SIZE)} batches of ~${(BATCH_SIZE * TRIPLES_PER_EMPLOYEE).toLocaleString()} triples...\n`,
        );
        const startInsert = Date.now();
        const batchTimes: number[] = [];

        for (let i = 0; i < EMPLOYEE_COUNT; i += BATCH_SIZE) {
          const batchStart = Date.now();
          const batch = allTriples.slice(
            i * TRIPLES_PER_EMPLOYEE,
            Math.min((i + BATCH_SIZE) * TRIPLES_PER_EMPLOYEE, allTriples.length),
          );

          yield* store.assertBatch(batch, BULK_OPTIONS);

          const batchTime = Date.now() - batchStart;
          batchTimes.push(batchTime);

          // Log progress every 5 batches
          if ((i / BATCH_SIZE + 1) % 5 === 0) {
            const processed = Math.min((i + BATCH_SIZE) * TRIPLES_PER_EMPLOYEE, allTriples.length);
            const elapsed = ((Date.now() - startInsert) / 1000).toFixed(1);
            const rate = processed / ((Date.now() - startInsert) / 1000);
            process.stderr.write(
              `  [${elapsed}s] Batch ${i / BATCH_SIZE + 1}/${Math.ceil(EMPLOYEE_COUNT / BATCH_SIZE)}: ${batchTime}ms | Total: ${processed.toLocaleString()} triples | Rate: ${rate.toFixed(0)}/s\n`,
            );
          }
        }

        const totalInsertTime = Date.now() - startInsert;

        process.stderr.write(`\n  Insertion complete! Starting query performance tests...\n\n`);

        return { genTime, totalInsertTime, batchTimes, totalTriples: allTriples.length };
      }).pipe(Effect.provide(TestLayer)),
    );

    // Calculate metrics
    const { genTime, totalInsertTime, batchTimes, totalTriples } = result;
    const throughput = totalTriples / (totalInsertTime / 1000);
    const avgBatch = batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length;
    const minBatch = Math.min(...batchTimes);
    const maxBatch = Math.max(...batchTimes);
    const variance = maxBatch / minBatch;

    // Report metrics
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  INSERTION METRICS [${BACKEND}]`);
    console.log(`${"=".repeat(60)}`);
    console.log(`Total triples:    ${totalTriples.toLocaleString()}`);
    console.log(`Generation time:  ${genTime}ms (${(genTime / 1000).toFixed(2)}s)`);
    console.log(`Insertion time:   ${totalInsertTime}ms (${(totalInsertTime / 1000).toFixed(2)}s)`);
    console.log(`Throughput:       ${throughput.toFixed(0)} triples/sec`);
    console.log(`Avg batch:        ${avgBatch.toFixed(0)}ms`);
    console.log(`Min batch:        ${minBatch}ms`);
    console.log(`Max batch:        ${maxBatch}ms`);
    console.log(`Variance:         ${variance.toFixed(2)}x`);
    console.log(`${"=".repeat(60)}\n`);

    // Get database size
    const dbSize = await getDatabaseSize(BACKEND);
    console.log(`  Database size: ${dbSize}\n`);

    // Assertions
    const expectedMin = EMPLOYEE_COUNT * 9; // 9 core attributes
    const expectedMax = EMPLOYEE_COUNT * 11; // 11 max (with optional manager)
    expect(totalTriples).toBeGreaterThanOrEqual(expectedMin);
    expect(totalTriples).toBeLessThanOrEqual(expectedMax);
    expect(throughput).toBeGreaterThan(thresholds.minThroughput);
    expect(totalInsertTime).toBeLessThan(thresholds.insertionTimeout);
  }, 600_000); // 10 minute timeout

  // ============================================================================
  // TripleStore Query Performance
  // ============================================================================

  describe("TripleStore Query Performance", () => {
    it("Q1: Single entity lookup", async () => {
      const targetId = `emp:${Math.floor(EMPLOYEE_COUNT / 2)}`;
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { store } = yield* getStoreAndDatalog();
          return yield* store.getEntity(targetId as EntityId);
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`Q1 - Entity lookup: ${duration}ms (${result.length} triples)`);
      expect(result.length).toBeGreaterThanOrEqual(9);
      expect(result.length).toBeLessThanOrEqual(10);
      expect(duration).toBeLessThan(thresholds.entityLookup);
    });

    it("Q2: Query by attribute", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { store } = yield* getStoreAndDatalog();
          return yield* store.query({ attribute: ":salary" });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`Q2 - Attribute scan: ${duration}ms (${result.length} results)`);
      expect(result.length).toBe(EMPLOYEE_COUNT);
      expect(duration).toBeLessThan(thresholds.attributeScan);
    });

    it("Q3: Query by entity type", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { store } = yield* getStoreAndDatalog();
          return yield* store.query({ entityType: "Employee" });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`Q3 - Type filter: ${duration}ms (${result.length} results)`);
      expect(result.length).toBe(EMPLOYEE_COUNT);
      expect(duration).toBeLessThan(thresholds.typeFilter);
    });

    it("Q4: Query by specific value", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { store } = yield* getStoreAndDatalog();
          return yield* store.query({
            attribute: ":department",
            value: string("Engineering"),
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      // With modulo distribution, each department gets ceil or floor of count/8
      const expectedMin = Math.floor(EMPLOYEE_COUNT / 8);
      const expectedMax = Math.ceil(EMPLOYEE_COUNT / 8);
      console.log(`Q4 - Value filter: ${duration}ms (${result.length} results)`);
      expect(result.length).toBeGreaterThanOrEqual(expectedMin);
      expect(result.length).toBeLessThanOrEqual(expectedMax);
      expect(duration).toBeLessThan(thresholds.valueFilter);
    });

    it("Q5: Follow reference", async () => {
      // Use a manager ID that exists at any scale: emp:0 is referenced by emp:10's manager
      // (managerId = max(0, 10 - 10 - 0) = 0 for i=10)
      const mgrId = EMPLOYEE_COUNT > 10 ? "emp:0" : "emp:0";
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { store } = yield* getStoreAndDatalog();
          return yield* store.query({
            attribute: ":manager",
            value: ref(mgrId),
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`Q5 - Reference lookup: ${duration}ms (${result.length} results)`);
      // At least some employees should reference this manager (if count > 10)
      if (EMPLOYEE_COUNT > 10) {
        expect(result.length).toBeGreaterThan(0);
      }
      expect(duration).toBeLessThan(thresholds.refLookup);
    });

    it("Q6: Get all active employees", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { store } = yield* getStoreAndDatalog();
          return yield* store.query({
            attribute: ":active",
            value: boolean(true),
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      const expected = EMPLOYEE_COUNT - Math.floor(EMPLOYEE_COUNT / 10); // 90% active
      console.log(`Q6 - Boolean filter: ${duration}ms (${result.length} results)`);
      expect(result.length).toBe(expected);
      expect(duration).toBeLessThan(thresholds.booleanFilter);
    });
  });

  // ============================================================================
  // Datalog Query Performance
  // ============================================================================

  describe("Datalog Query Performance", () => {
    it("D1: Simple pattern - find all names", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { datalog } = yield* getStoreAndDatalog();
          return yield* datalog.queryValidated({
            find: ["?name"],
            where: [["?e", ":name", "?name"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`D1 - Simple pattern: ${duration}ms (${result.results.length} results)`);
      expect(result.results.length).toBe(EMPLOYEE_COUNT);
      expect(duration).toBeLessThan(thresholds.datalogSimple);
    });

    it("D2: Two-variable join - name + department", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { datalog } = yield* getStoreAndDatalog();
          return yield* datalog.queryValidated({
            find: ["?name", "?dept"],
            where: [
              ["?e", ":name", "?name"],
              ["?e", ":department", "?dept"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`D2 - Two-variable join: ${duration}ms (${result.results.length} results)`);
      expect(result.results.length).toBe(EMPLOYEE_COUNT);
      expect(duration).toBeLessThan(thresholds.datalogJoin);
    });

    it("D3: Predicate filter - salary >= threshold", async () => {
      // Salary formula: 50000 + titleIdx * 25000 + (i % 50000)
      // titleIdx = min(floor(i / 20000), 5)
      // At small scale (100 employees): salary = 50000..50099 (all titleIdx=0)
      // At full scale (100k): salary ranges from 50000 to ~225000
      // Use median salary as threshold to get roughly half the employees
      const salaryThreshold = 50000 + Math.floor(EMPLOYEE_COUNT / 4);
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { datalog } = yield* getStoreAndDatalog();
          return yield* datalog.queryValidated({
            find: ["?name", "?salary"],
            where: [
              ["?e", ":name", "?name"],
              ["?e", ":salary", "?salary"],
              [">=", "?salary", salaryThreshold],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`D3 - Predicate filter: ${duration}ms (${result.results.length} results)`);
      // Some employees should have salary >= threshold
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.length).toBeLessThanOrEqual(EMPLOYEE_COUNT);
      expect(duration).toBeLessThan(thresholds.datalogPredicate);
    });

    it("D4: Multi-attribute with value binding - Engineering employees", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { datalog } = yield* getStoreAndDatalog();
          return yield* datalog.queryValidated({
            find: ["?name", "?title"],
            where: [
              ["?e", ":name", "?name"],
              ["?e", ":department", "Engineering"],
              ["?e", ":title", "?title"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      // With modulo distribution, each department gets ceil or floor of count/8
      const expectedMin = Math.floor(EMPLOYEE_COUNT / 8);
      const expectedMax = Math.ceil(EMPLOYEE_COUNT / 8);
      console.log(`D4 - Multi-attribute: ${duration}ms (${result.results.length} results)`);
      expect(result.results.length).toBeGreaterThanOrEqual(expectedMin);
      expect(result.results.length).toBeLessThanOrEqual(expectedMax);
      expect(duration).toBeLessThan(thresholds.datalogMultiAttr);
    });

    it("D5: Aggregation - count per department", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { datalog } = yield* getStoreAndDatalog();
          return yield* datalog.queryValidated({
            find: ["?dept", "?count"],
            where: [["?e", ":department", "?dept"]],
            aggregate: [["count", "?e", "?count"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`D5 - Aggregation: ${duration}ms (${result.results.length} rows)`);
      expect(result.results.length).toBe(8); // 8 departments
      expect(duration).toBeLessThan(thresholds.datalogAggregation);
    });

    it("D6: Reference traversal - employee + manager name", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { datalog } = yield* getStoreAndDatalog();
          return yield* datalog.queryValidated({
            find: ["?empName", "?mgrName"],
            where: [
              ["?e", ":name", "?empName"],
              ["?e", ":manager", "?mgr"],
              ["?mgr", ":name", "?mgrName"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      // ~20% of employees have manager refs
      const expectedMin = Math.floor(EMPLOYEE_COUNT * 0.15);
      const expectedMax = Math.floor(EMPLOYEE_COUNT * 0.25);
      console.log(`D6 - Ref traversal: ${duration}ms (${result.results.length} results)`);
      expect(result.results.length).toBeGreaterThanOrEqual(expectedMin);
      expect(result.results.length).toBeLessThanOrEqual(expectedMax);
      expect(duration).toBeLessThan(thresholds.datalogRefTraversal);
    });
  });

  afterAll(async () => {
    await cleanupAfter(BACKEND);
  });
});
