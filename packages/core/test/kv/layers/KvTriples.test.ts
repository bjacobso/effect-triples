/**
 * Tests for the merged KV `Triples` layer.
 *
 * Exercises writes and Datalog reads through the single service, including a
 * regression test for retract/query cache coherence.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { KvTriples, Triples } from "../../../src/index.js";

const run = <A, E>(effect: Effect.Effect<A, E, Triples>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(KvTriples.layer)));

describe("KvTriples (merged service)", () => {
  it("asserts and reads a fact back through match + datalog query", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        yield* t.assert({
          entityId: "p1",
          attribute: ":name",
          value: { type: "string", value: "Alice" },
          entityType: "Person",
        });

        const matched = yield* t.match({ entityId: "p1", attribute: ":name" });
        const { results } = yield* t.query({
          find: ["?name"],
          where: [["?p", ":name", "?name"]],
        });
        return { matched: matched.length, names: results.map((r) => r["?name"]) };
      }),
    );

    expect(result.matched).toBe(1);
    expect(result.names).toContain("Alice");
  });

  it("transact writes :_tx/instant and :_tx/user provenance datoms", async () => {
    const attrs = await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const tx = yield* t.transact(
          [
            {
              op: "assert",
              entityId: "p2",
              attribute: ":age",
              value: { type: "number", value: 30 },
              entityType: "Person",
            },
          ],
          { user: "alice" },
        );
        const txTriples = yield* t.match({ entityId: tx.txId });
        return txTriples.map((tr) => tr.attribute as string);
      }),
    );

    expect(attrs).toContain(":_tx/instant");
    expect(attrs).toContain(":_tx/user");
  });

  // Regression: retracts must invalidate the same hexastore cache used by
  // Datalog queries.
  it("does not surface a write-path retraction as a stale datalog result", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const triple = yield* t.assert({
          entityId: "widget:1",
          attribute: ":active",
          value: { type: "boolean", value: true },
          entityType: "Widget",
        });

        // Query once so any cache is warm, then retract via the write path.
        yield* t.query({ find: ["?e"], where: [["?e", ":active", true]] });
        yield* t.retract(triple.id);

        const { results } = yield* t.query({
          find: ["?e"],
          where: [["?e", ":active", true]],
        });
        return results.map((r) => r["?e"]);
      }),
    );

    expect(seen).not.toContain("widget:1");
  });

  it("evaluates recursive rules through the merged service (KV semi-naive)", async () => {
    const ancestors = await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        yield* t.assertBatch([
          { entityId: "a", attribute: ":parent", value: { type: "ref", value: "b" } },
          { entityId: "b", attribute: ":parent", value: { type: "ref", value: "c" } },
        ]);

        const { results } = yield* t.query({
          find: ["?ancestor"],
          where: [["ancestor", "a", "?ancestor"]],
          rules: [
            { name: "ancestor", body: [["?x", ":parent", "?y"]] },
            {
              name: "ancestor",
              body: [
                ["?x", ":parent", "?z"],
                ["ancestor", "?z", "?y"],
              ],
            },
          ],
        });
        return results.map((r) => r["?ancestor"]).sort();
      }),
    );

    // a's ancestors are b and c (transitively).
    expect(ancestors).toContain("b");
    expect(ancestors).toContain("c");
  });
});
