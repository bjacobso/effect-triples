import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrations, runMigrations } from "@bjacobso/triplex-sql";
import { makeSqliteLayerUnmigrated } from "../src/SqliteLayer.js";

const runUnmigrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeSqliteLayerUnmigrated(":memory:"))));

describe("host-owned SQLite migrations", () => {
  it("starts without DDL and applies the exported migrations idempotently", async () => {
    const result = await runUnmigrated(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'triples'
        `;

        yield* runMigrations;
        yield* runMigrations;

        const applied = yield* sql<{ version: number }>`
          SELECT version FROM triplex_schema_migrations ORDER BY version
        `;
        const columns = yield* sql.unsafe<{ name: string }>("PRAGMA table_info(triples)");
        return { before, applied, columns };
      }),
    );

    expect(result.before).toHaveLength(0);
    expect(result.applied.map(({ version }) => version)).toEqual(
      migrations.map(({ version }) => version),
    );
    expect(result.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["recorded_at", "recorded_retracted_at", "valid_from", "valid_to"]),
    );
  });

  it("backfills temporal facts and snapshot source positions from the baseline", async () => {
    const result = await runUnmigrated(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const statement of migrations[0]!.up) yield* sql.unsafe(statement);
        yield* sql`
          CREATE TABLE triplex_schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at BIGINT NOT NULL
          )
        `;
        yield* sql`
          INSERT INTO triplex_schema_migrations (version, name, applied_at)
          VALUES (1, 'triplex_baseline', 1000)
        `;
        yield* sql`
          INSERT INTO triples (
            id, entity_id, attribute, value_type, value_string,
            created_at, retracted_at, retract_tx_id, tx_id
          ) VALUES (
            'old-fact', 'entity:1', ':entity/name', 'string', 'before',
            1000, 2000, 'tx-retract', 'tx-assert'
          )
        `;
        yield* sql`
          INSERT INTO triples (
            id, entity_id, attribute, value_type, value_number, created_at, tx_id
          ) VALUES (
            'old-position', 'tx-assert', ':_tx/position', 'number', 7, 1000, 'tx-assert'
          )
        `;
        yield* sql`
          INSERT INTO entity_blobs (hash, data, format_version, byte_size, ref_count)
          VALUES ('hash', '[]', 2, 2, 1)
        `;
        yield* sql`
          INSERT INTO entity_snapshots (entity_id, tx_id, hash, tx_time, entity_type)
          VALUES ('entity:1', 'tx-assert', 'hash', 1000, 'Entity')
        `;

        yield* runMigrations;

        const facts = yield* sql<{
          recorded_at: number;
          recorded_retracted_at: number;
          valid_from: number;
          valid_to: number | null;
          retract_tx_id: string;
        }>`SELECT recorded_at, recorded_retracted_at, valid_from, valid_to, retract_tx_id
           FROM triples WHERE id = 'old-fact'`;
        const snapshots = yield* sql<{ tx_position: number }>`
          SELECT tx_position FROM entity_snapshots WHERE entity_id = 'entity:1'
        `;
        return { fact: facts[0]!, snapshot: snapshots[0]! };
      }),
    );

    expect(result.fact).toEqual({
      recorded_at: 1000,
      recorded_retracted_at: 2000,
      valid_from: 1000,
      valid_to: null,
      retract_tx_id: "tx-retract",
    });
    expect(result.snapshot.tx_position).toBe(7);
  });
});
