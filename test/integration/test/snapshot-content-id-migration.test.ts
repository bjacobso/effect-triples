import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { hashCanonical } from "@bjacobso/triplex";
import { migrations } from "@bjacobso/triplex-sql";

import { SqliteTestLayer } from "./fixtures/SqliteTestLayer.js";

describe("entity snapshot ContentId migration", () => {
  it("removes legacy FNV rows without touching SHA-256 snapshots", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacyHash = "fnv1a:deadbeef";
        const currentHash = hashCanonical("[]");

        yield* sql`
          INSERT INTO entity_blobs (hash, data, format_version, byte_size, ref_count)
          VALUES
            (${legacyHash}, ${"[]"}, ${1}, ${2}, ${1}),
            (${currentHash}, ${"[]"}, ${2}, ${2}, ${1})
        `;
        yield* sql`
          INSERT INTO entity_snapshots (entity_id, tx_id, hash, tx_time, entity_type)
          VALUES
            (${"person:legacy"}, ${"tx:legacy"}, ${legacyHash}, ${1}, ${"Person"}),
            (${"person:current"}, ${"tx:current"}, ${currentHash}, ${2}, ${"Person"})
        `;

        for (const version of [20, 21]) {
          const migration = migrations.find((candidate) => candidate.version === version);
          expect(migration).toBeDefined();
          yield* sql.unsafe(migration!.up);
        }

        const snapshots = yield* sql<{ hash: string }>`
          SELECT hash FROM entity_snapshots ORDER BY hash
        `;
        const blobs = yield* sql<{ hash: string; format_version: number }>`
          SELECT hash, format_version FROM entity_blobs ORDER BY hash
        `;

        expect(snapshots).toEqual([{ hash: currentHash }]);
        expect(blobs).toEqual([{ hash: currentHash, format_version: 2 }]);
      }).pipe(Effect.provide(SqliteTestLayer)),
    );
  });
});
