/**
 * Shared backend test helpers for Effect Triples.
 *
 * The centrepiece is {@link makeTriplesConformanceSuite}: a single behavioral
 * suite, expressed as an `Effect` that requires a {@link Triples} service, which
 * every backend layer (SQLite, PostgreSQL, in-memory KV, FoundationDB) should
 * satisfy identically. Run it against a backend's `Layer<Triples>` to assert
 * cross-backend parity — including the write/Datalog coherence that the merged
 * `Triples` service guarantees.
 */

import { Effect } from "effect";
import { Triples, type EntityId } from "effect-triples";

// ─── Lightweight fixture descriptors (unchanged) ────────────────────────────

export interface DatabaseBackendFixture {
  readonly name: string;
  readonly capabilities?: readonly string[];
}

export const defineBackendFixture = (fixture: DatabaseBackendFixture): DatabaseBackendFixture =>
  fixture;

export const expectBackendCapability = (
  fixture: DatabaseBackendFixture,
  capability: string,
): boolean => fixture.capabilities?.includes(capability) ?? false;

// ─── Conformance suite ──────────────────────────────────────────────────────

class ConformanceError extends Error {
  override readonly name = "ConformanceError";
}

const check = (condition: boolean, message: string): Effect.Effect<void, ConformanceError> =>
  condition ? Effect.void : Effect.fail(new ConformanceError(message));

/**
 * A single conformance behavior: a label plus the `Triples`-requiring effect
 * that verifies it. Exposed individually so a test runner can turn each into
 * its own `it`/`test` case if desired.
 */
export interface ConformanceCase {
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, Triples>;
}

/**
 * The behavioral cases every `Triples` backend must pass.
 */
export const triplesConformanceCases: readonly ConformanceCase[] = [
  {
    name: "assert then get and match return the fact",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const triple = yield* t.assert({
        entityId: "conf:person:1",
        attribute: ":name",
        value: { type: "string", value: "Alice" },
        entityType: "Person",
      });

      const got = yield* t.get(triple.id);
      yield* check(got !== null && got.id === triple.id, "get should return the asserted triple");

      const matched = yield* t.match({ entityId: "conf:person:1", attribute: ":name" });
      yield* check(
        matched.length === 1 && matched[0]!.value.type === "string",
        "match should return exactly the asserted triple",
      );

      const entity = yield* t.entity("conf:person:1" as EntityId);
      yield* check(entity.length >= 1, "entity should return the asserted triple");
    }),
  },
  {
    name: "datalog query finds asserted facts",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assert({
        entityId: "conf:person:2",
        attribute: ":name",
        value: { type: "string", value: "Bob" },
        entityType: "Person",
      });

      const { results } = yield* t.query({
        find: ["?name"],
        where: [["?p", ":name", "?name"]],
      });
      const names = results.map((r) => r["?name"]);
      yield* check(names.includes("Bob"), "datalog query should surface Bob");
    }),
  },
  {
    name: "transact records provenance datoms",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const result = yield* t.transact(
        [
          {
            op: "assert",
            entityId: "conf:person:3",
            attribute: ":age",
            value: { type: "number", value: 30 },
            entityType: "Person",
          },
        ],
        { user: "conformance-tester" },
      );

      const txTriples = yield* t.match({ entityId: result.txId });
      const attributes = new Set(txTriples.map((tr) => tr.attribute as string));
      yield* check(
        attributes.has(":_tx/instant"),
        "transact should write a :_tx/instant provenance datom",
      );
      yield* check(
        attributes.has(":_tx/user"),
        "transact should write a :_tx/user provenance datom when a user is given",
      );
    }),
  },
  {
    name: "retract is coherent across write and datalog paths",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const triple = yield* t.assert({
        entityId: "conf:coherence:1",
        attribute: ":flag",
        value: { type: "boolean", value: true },
        entityType: "Widget",
      });

      // Retract via the write path, then immediately read via the Datalog path.
      // If the two paths shared a stale cache this would still see the fact.
      yield* t.retract(triple.id);

      const { results } = yield* t.query({
        find: ["?e"],
        where: [["?e", ":flag", true]],
      });
      const entities = results.map((r) => r["?e"]);
      yield* check(
        !entities.includes("conf:coherence:1"),
        "datalog query must not see a fact retracted via the write path",
      );

      const matched = yield* t.match({ entityId: "conf:coherence:1", attribute: ":flag" });
      yield* check(matched.length === 0, "match must not see the retracted fact either");
    }),
  },
];

/**
 * Build the full conformance suite as one `Effect` requiring a `Triples`
 * service. Provide a backend's `Layer<Triples>` and run it:
 *
 * ```ts
 * await Effect.runPromise(
 *   makeTriplesConformanceSuite().pipe(Effect.provide(KvTriples.layer), Effect.scoped),
 * )
 * ```
 */
export const makeTriplesConformanceSuite = (): Effect.Effect<void, unknown, Triples> =>
  Effect.forEach(triplesConformanceCases, (c) => c.run, { discard: true });
