# @open-ontology/stress

Performance and stress tests for the Open Ontology triple store at scale, supporting multiple storage backends.

## Overview

These tests validate that each storage backend can handle production workloads by:
- Inserting ~10 million triples (1M employee records × 10 attributes)
- Running 10 rounds of updates (retract-then-assert) across 5 attributes per employee
- Running common TripleStore query patterns (Q1-Q6)
- Running Datalog query patterns including joins, predicates, aggregations, and reference traversal (D1-D6)
- Measuring insertion, update, and query throughput with backend-specific thresholds
- Identifying performance bottlenecks across backends

Tests use `DatabaseManager` — the same public API that production code uses — to construct `TripleStore` and `Datalog` services.

## Supported Backends

| Backend | Engine | Storage | Use Case |
|---------|--------|---------|----------|
| `sqlite` | SQLite (better-sqlite3) | File-based | Default. Production single-node deployments. |
| `pg` | PostgreSQL (@effect/sql-pg) | Network database | Production multi-node deployments. Requires running PG server. |

## Benchmark Report

Generate a side-by-side SQLite vs PostgreSQL performance report at `docs/performance.md`:

```bash
# Full benchmark (1M employees, 10 update rounds, auto-starts PostgreSQL via Docker)
pnpm --filter @open-ontology/core-stress benchmark

# Customize scale
STRESS_EMPLOYEE_COUNT=100000 STRESS_UPDATE_ROUNDS=5 pnpm --filter @open-ontology/core-stress benchmark

# Skip updates (insertion + queries only)
STRESS_UPDATE_ROUNDS=0 pnpm --filter @open-ontology/core-stress benchmark

# SQLite only (no Docker required)
BENCHMARK_SKIP_PG=true pnpm --filter @open-ontology/core-stress benchmark
```

**Requirements**: Docker (for PostgreSQL). If Docker is not available, the script automatically skips PostgreSQL and benchmarks SQLite only.

The generated report includes insertion throughput, update throughput with per-round breakdown, TripleStore query latency (Q1-Q6), and Datalog query latency (D1-D6) with system information and methodology notes.

## Running Tests

### SQLite (default)

```bash
# Default - no optimizations
pnpm --filter @open-ontology/stress stress-test

# With index dropping optimization (3-5x faster insertion, SQLite only)
STRESS_DROP_INDEXES=true pnpm --filter @open-ontology/stress stress-test

# With unsafe PRAGMA settings (1.2-2x faster, data loss risk, SQLite only)
STRESS_UNSAFE_MODE=true pnpm --filter @open-ontology/stress stress-test

# Both optimizations (maximum speed)
STRESS_DROP_INDEXES=true STRESS_UNSAFE_MODE=true pnpm --filter @open-ontology/stress stress-test

# Keep database after test for inspection
STRESS_TEST_KEEP_DB=true pnpm --filter @open-ontology/stress stress-test
```

### PostgreSQL

Requires a running PostgreSQL server:

```bash
# Run against PostgreSQL
STRESS_BACKEND=pg DATABASE_URL=postgresql://user:pass@localhost:5432/ontology_stress \
  pnpm --filter @open-ontology/stress stress-test

# With fewer employees to speed things up
STRESS_BACKEND=pg DATABASE_URL=postgresql://user:pass@localhost:5432/ontology_stress \
  STRESS_EMPLOYEE_COUNT=50000 pnpm --filter @open-ontology/stress stress-test
```

### Watch Mode

```bash
# Re-runs on file changes (useful during development)
pnpm --filter @open-ontology/stress test:watch
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STRESS_BACKEND` | `sqlite` | Backend to test: `sqlite`, `pg`, or `kv` |
| `STRESS_EMPLOYEE_COUNT` | `100000` | Number of employees to generate. Each produces ~10 triples. Benchmark script defaults to 1,000,000. |
| `STRESS_UPDATE_ROUNDS` | `10` | Number of update rounds. Each round updates 5 attributes per employee. Set to 0 to skip. |
| `DATABASE_URL` | _(empty)_ | PostgreSQL connection URL. **Required** when `STRESS_BACKEND=pg`. |
| `STRESS_DROP_INDEXES` | `false` | Drop indexes before bulk insert, recreate after. SQLite only. ~3-5x speedup. |
| `STRESS_UNSAFE_MODE` | `false` | Use `PRAGMA synchronous=OFF` and `journal_mode=MEMORY`. SQLite only. ~1.2-2x speedup. **WARNING: Data loss possible on crash.** |
| `STRESS_TEST_KEEP_DB` | `false` | Keep the test database for inspection after the test completes. |

**Note**: `STRESS_DROP_INDEXES` and `STRESS_UNSAFE_MODE` only affect the SQLite backend. They are silently ignored by PostgreSQL.

**Note**: Stress tests are in a separate package and excluded from normal `pnpm test` runs and CI.

## Test Data

The stress test generates employee records with **10 attributes each**:

- `:name` - Employee name (string)
- `:email` - Email address (string)
- `:age` - Age 25-65 (number)
- `:salary` - Salary $50k-$225k, correlated with level (number)
- `:department` - 8 departments: Engineering, Sales, Marketing, HR, Finance, Operations, Legal, Support (string)
- `:title` - 6 levels: Junior, Mid-Level, Senior, Staff, Lead, Principal (string)
- `:active` - 90% true (boolean)
- `:hire_date` - Distributed over past days (datetime)
- `:location` - 5 locations: NYC, SF, Austin, Remote, London (string)
- `:manager` - 20% have manager references (ref)

**Total**: ~`EMPLOYEE_COUNT * 10` triples (default: ~1,000,000)

### Distribution Characteristics

- **More junior than senior**: Realistic organizational pyramid
- **Salary correlates with level**: Base + level premium + variation
- **Graph structure**: Manager references create queryable relationships (20% of employees)
- **Realistic distributions**: Age cycles 25-65, departments evenly distributed

## TripleStore Query Tests (Q1-Q6)

These tests exercise the `TripleStore.query` and `TripleStore.getEntity` APIs directly:

| ID | Test | Query Pattern | Expected Results | Description |
|----|------|--------------|------------------|-------------|
| Q1 | Single entity lookup | `getEntity("emp:N")` | 9-10 triples | Point lookup by entity ID |
| Q2 | Attribute scan | `query({ attribute: ":salary" })` | All employees | Full scan of one attribute |
| Q3 | Entity type filter | `query({ entityType: "Employee" })` | All employees | Filter by entity type |
| Q4 | Specific value | `query({ attribute: ":department", value: "Engineering" })` | 1/8 of employees | Composite attribute+value |
| Q5 | Reference lookup | `query({ attribute: ":manager", value: ref("emp:100") })` | > 0 | Reference traversal |
| Q6 | Boolean filter | `query({ attribute: ":active", value: true })` | 90% of employees | Boolean value filter |

## Datalog Query Tests (D1-D6)

These tests exercise the `Datalog.queryValidated` API with increasingly complex query patterns:

| ID | Test | Datalog Pattern | Expected Results | Description |
|----|------|----------------|------------------|-------------|
| D1 | Simple pattern | `find: [?name], where: [[?e, :name, ?name]]` | All employees | Single pattern clause |
| D2 | Two-variable join | `find: [?name, ?dept], where: [[?e, :name, ?name], [?e, :department, ?dept]]` | All employees | Self-join on entity variable |
| D3 | Predicate filter | `find: [?name, ?salary], where: [..., [>=, ?salary, 150000]]` | Subset | Numeric predicate |
| D4 | Multi-attribute | `find: [?name, ?title], where: [..., [?e, :department, "Engineering"]]` | 1/8 employees | Value-bound pattern |
| D5 | Aggregation | `find: [?dept, (count ?e)], where: [[?e, :department, ?dept]]` | 8 rows | Group by + count |
| D6 | Reference traversal | `find: [?empName, ?mgrName], where: [..., [?e, :manager, ?mgr], [?mgr, :name, ?mgrName]]` | ~20% employees | Ref join across entities |

## Expected Performance

Performance thresholds are backend-specific to account for different storage characteristics:

### TripleStore Queries

| Metric | SQLite | PostgreSQL |
|--------|--------|------------|
| Insertion throughput | > 1,000/s | > 500/s |
| Q1: Entity lookup | < 200ms | < 200ms |
| Q2: Attribute scan | < 2,000ms | < 3,000ms |
| Q3: Type filter | < 2,000ms | < 3,000ms |
| Q4: Value filter | < 200ms | < 300ms |
| Q5: Ref lookup | < 100ms | < 200ms |
| Q6: Boolean filter | < 500ms | < 1,000ms |

### Datalog Queries

| Metric | SQLite | PostgreSQL |
|--------|--------|------------|
| D1: Simple pattern | < 3,000ms | < 5,000ms |
| D2: Two-variable join | < 5,000ms | < 8,000ms |
| D3: Predicate filter | < 5,000ms | < 8,000ms |
| D4: Multi-attribute | < 3,000ms | < 5,000ms |
| D5: Aggregation | < 5,000ms | < 8,000ms |
| D6: Ref traversal | < 5,000ms | < 8,000ms |

## Implemented Optimizations (SQLite Only)

### 1. Multi-Row INSERT (DEFAULT)

`assertBatch` uses multi-row INSERT statements instead of sequential individual inserts.

### 2. Index Management (STRESS_DROP_INDEXES=true)

Drop 9 partial indexes before bulk insert, rebuild after. ~3-5x faster insertion.

### 3. PRAGMA Tuning (STRESS_UNSAFE_MODE=true)

```sql
PRAGMA synchronous = OFF;
PRAGMA journal_mode = MEMORY;
PRAGMA cache_size = -128000;
```

~1.2-2x faster. **WARNING**: Data may be lost if the process crashes during import.

## Database Inspection

### SQLite

```bash
# Keep database
STRESS_TEST_KEEP_DB=true pnpm --filter @open-ontology/stress stress-test

# Inspect
sqlite3 stress-data/stress-test.db
.schema triples
SELECT COUNT(*) FROM triples;
EXPLAIN QUERY PLAN SELECT * FROM triples WHERE entity_id = 'emp:100';
```

### PostgreSQL

```bash
# Keep data
STRESS_BACKEND=pg DATABASE_URL=... STRESS_TEST_KEEP_DB=true \
  pnpm --filter @open-ontology/stress stress-test

# Inspect via psql
psql $DATABASE_URL
SELECT COUNT(*) FROM triples;
```

## Architecture

```
              STRESS_BACKEND env var
            +---------+---------+
            |                   |
       "sqlite"               "pg"
            |                   |
    +-------+------+    +------+-------+
    |SqliteBackend |    |PgBackend     |
    |  (via        |    | (via make-   |
    |  makeSqlite  |    |  PostgresqlBk|
    |  Backend)    |    |  FromUrl)    |
    +------+-------+    +------+-------+
           |                   |
           +--------+----------+
                    |
          DatabaseManagerLive
            + DatabaseRegistryLive
                    |
            DatabaseManager
                    |
          +---------+-----------+
          |                     |
    manager.getStore()    manager.getDatalog()
          |                     |
    TripleStoreService    DatalogService
    stress tests          stress tests
    (Q1-Q6)               (D1-D6)
```

## Troubleshooting

### Test Times Out

Increase timeout in vitest.config.ts (currently 10 minutes):

```typescript
testTimeout: 1200000, // 20 minutes
```

### PostgreSQL Connection Refused

Ensure PostgreSQL is running and `DATABASE_URL` is correct:

```bash
# Test connectivity
psql $DATABASE_URL -c "SELECT 1"
```

### Slow Insertion

- **SQLite**: Try `STRESS_DROP_INDEXES=true STRESS_UNSAFE_MODE=true`
- **PostgreSQL**: Check connection latency, consider local PG instance

### No Console Output

This package uses `disableConsoleIntercept: true` in vitest.config.ts to show real-time progress.

## Contributing

When adding new stress tests:
1. Follow existing patterns in `test/triple-store-stress.test.ts`
2. Use realistic data from `src/data-generator.ts` or create new generators
3. Add backend-specific thresholds in `src/backend.ts`
4. Update performance tables in this README
5. Test against all backends before submitting
