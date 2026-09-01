/**
 * Shared backend test helpers for Triplex.
 *
 * The centrepiece is {@link makeTriplesConformanceSuite}: a single behavioral
 * suite, expressed as an `Effect` that requires a {@link Triples} service, which
 * every backend layer (SQLite, PostgreSQL, in-memory KV, FoundationDB) should
 * satisfy identically. Run it against a backend's `Layer<Triples>` to assert
 * cross-backend parity — including the write/Datalog coherence that the merged
 * `Triples` service guarantees.
 */

import { Effect } from "effect";
import {
  boolean,
  datetime,
  json,
  number,
  ref,
  string,
  TransactionConflictError,
  Triples,
  type EntityId,
} from "@bjacobso/triplex";

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
    name: "same-value facts in one batch keep distinct identities",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const input = {
        entityId: "conf:duplicate:1",
        attribute: ":conf/value",
        value: string("same"),
      } as const;
      const asserted = yield* t.assertBatch([input, input]);
      const matched = yield* t.match({
        entityId: input.entityId,
        attribute: input.attribute,
        value: input.value,
      });
      yield* check(
        asserted[0]?.id !== asserted[1]?.id && matched.length === 2,
        "same-value facts in one transaction must not overwrite an index entry",
      );
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
    name: "datalog projections preserve scalar types without guessing from text",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        { entityId: "42", attribute: ":conf/code", value: string("007") },
        { entityId: "42", attribute: ":conf/count", value: number(7) },
        { entityId: "42", attribute: ":conf/enabled", value: boolean(true) },
        { entityId: "42", attribute: ":conf/instant", value: datetime(1_700_000_000_000) },
        { entityId: "42", attribute: ":conf/data", value: json({ ok: true }) },
        { entityId: "42", attribute: ":conf/owner", value: ref("7") },
      ]);

      const { results } = yield* t.query({
        find: ["?entity", "?code", "?count", "?enabled", "?instant", "?data", "?owner"],
        where: [
          ["?entity", ":conf/code", "?code"],
          ["?entity", ":conf/count", "?count"],
          ["?entity", ":conf/enabled", "?enabled"],
          ["?entity", ":conf/instant", "?instant"],
          ["?entity", ":conf/data", "?data"],
          ["?entity", ":conf/owner", "?owner"],
        ],
      });
      const row = results[0];
      yield* check(results.length === 1, "typed projection fixture should produce one row");
      yield* check(row?.["?entity"] === "42", "numeric-looking entity IDs must stay strings");
      yield* check(row?.["?code"] === "007", "numeric-looking string values must stay strings");
      yield* check(row?.["?count"] === 7, "number values must project as numbers");
      yield* check(row?.["?enabled"] === true, "boolean values must project as booleans");
      yield* check(
        row?.["?instant"] === 1_700_000_000_000,
        "datetime values must project as epoch numbers",
      );
      yield* check(row?.["?data"] === '{"ok":true}', "JSON values must use canonical row text");
      yield* check(row?.["?owner"] === "7", "numeric-looking refs must stay strings");
    }),
  },
  {
    name: "datalog value joins compare every scalar family",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        { entityId: "conf:join:left:number", attribute: ":conf/left", value: number(7) },
        { entityId: "conf:join:right:number", attribute: ":conf/right", value: number(7) },
        { entityId: "conf:join:left:string", attribute: ":conf/left", value: string("7") },
        { entityId: "conf:join:right:string", attribute: ":conf/right", value: string("7") },
        { entityId: "conf:join:right:other", attribute: ":conf/right", value: number(8) },
      ]);

      const { results } = yield* t.query({
        find: ["?left", "?right"],
        where: [
          ["?left", ":conf/left", "?value"],
          ["?right", ":conf/right", "?value"],
        ],
      });
      const pairs = results.map((row) => `${row["?left"]}->${row["?right"]}`).sort();
      yield* check(
        JSON.stringify(pairs) ===
          JSON.stringify([
            "conf:join:left:number->conf:join:right:number",
            "conf:join:left:string->conf:join:right:string",
          ]),
        "value joins must match numeric and textual families without crossing them",
      );
    }),
  },
  {
    name: "datalog equality predicates compare numeric values as numbers",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        { entityId: "conf:eq:number", attribute: ":conf/equality", value: number(7) },
        { entityId: "conf:eq:datetime", attribute: ":conf/equality", value: datetime(7) },
        { entityId: "conf:eq:string", attribute: ":conf/equality", value: string("7") },
        { entityId: "conf:eq:other", attribute: ":conf/equality", value: number(8) },
      ]);

      const equal = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/equality", "?value"],
          ["=", "?value", 7],
        ],
      });
      const unequal = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/equality", "?value"],
          ["!=", "?value", 7],
        ],
      });
      yield* check(
        JSON.stringify(equal.results.map((row) => row["?entity"]).sort()) ===
          JSON.stringify(["conf:eq:datetime", "conf:eq:number"]),
        "numeric equality must include number and datetime scalars",
      );
      yield* check(
        JSON.stringify(unequal.results.map((row) => row["?entity"]).sort()) ===
          JSON.stringify(["conf:eq:other", "conf:eq:string"]),
        "numeric inequality must preserve type-aware scalar semantics",
      );
    }),
  },
  {
    name: "datalog reverse lookup matches an explicitly typed ref constant",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: "conf:refs:typed:mid",
          attribute: ":conf/typed-child",
          value: ref("conf:refs:typed:leaf"),
        },
        {
          entityId: "conf:refs:typed:other",
          attribute: ":conf/typed-child",
          value: ref("conf:refs:typed:leaf"),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?parent"],
        where: [["?parent", ":conf/typed-child", ref("conf:refs:typed:leaf")]],
      });
      const parents = results.map((row) => row["?parent"]).sort();
      yield* check(
        JSON.stringify(parents) ===
          JSON.stringify(["conf:refs:typed:mid", "conf:refs:typed:other"]),
        "typed ref reverse lookup should find every parent",
      );
    }),
  },
  {
    name: "datalog joins a variable bound from a ref in value position",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: "conf:refs:join:mid",
          attribute: ":conf/join-child",
          value: ref("conf:refs:join:leaf"),
        },
        {
          entityId: "conf:refs:join:other",
          attribute: ":conf/join-child",
          value: ref("conf:refs:join:leaf"),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?parent"],
        where: [
          ["conf:refs:join:mid", ":conf/join-child", "?leaf"],
          ["?parent", ":conf/join-child", "?leaf"],
        ],
      });
      const parents = results.map((row) => row["?parent"]).sort();
      yield* check(
        JSON.stringify(parents) === JSON.stringify(["conf:refs:join:mid", "conf:refs:join:other"]),
        "a ref-valued binding should join against ref-valued facts",
      );
    }),
  },
  {
    name: "datalog supports multi-hop joins over ref edges",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: "conf:refs:hops:grand",
          attribute: ":conf/hops-child",
          value: ref("conf:refs:hops:parent"),
        },
        {
          entityId: "conf:refs:hops:parent",
          attribute: ":conf/hops-child",
          value: ref("conf:refs:hops:leaf"),
        },
        {
          entityId: "conf:refs:hops:sibling",
          attribute: ":conf/hops-child",
          value: ref("conf:refs:hops:leaf"),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?grandparent", "?leafParent"],
        where: [
          ["?grandparent", ":conf/hops-child", "?parent"],
          ["?parent", ":conf/hops-child", "?leaf"],
          ["?leafParent", ":conf/hops-child", "?leaf"],
        ],
      });
      const paths = results
        .map((row) => `${String(row["?grandparent"])}->${String(row["?leafParent"])}`)
        .sort();
      yield* check(
        JSON.stringify(paths) ===
          JSON.stringify([
            "conf:refs:hops:grand->conf:refs:hops:parent",
            "conf:refs:hops:grand->conf:refs:hops:sibling",
          ]),
        "multi-hop ref joins should preserve every matching path",
      );
    }),
  },
  {
    name: "datalog untyped strings match string and ref values while typed refs stay exact",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: "conf:refs:mixed:ref",
          attribute: ":conf/mixed-value",
          value: ref("conf:refs:mixed:target"),
        },
        {
          entityId: "conf:refs:mixed:string",
          attribute: ":conf/mixed-value",
          value: string("conf:refs:mixed:target"),
        },
      ]);

      const bare = yield* t.query({
        find: ["?entity"],
        where: [["?entity", ":conf/mixed-value", "conf:refs:mixed:target"]],
      });
      const typed = yield* t.query({
        find: ["?entity"],
        where: [["?entity", ":conf/mixed-value", ref("conf:refs:mixed:target")]],
      });
      const bareEntities = bare.results.map((row) => row["?entity"]).sort();
      const typedEntities = typed.results.map((row) => row["?entity"]).sort();

      yield* check(
        JSON.stringify(bareEntities) ===
          JSON.stringify(["conf:refs:mixed:ref", "conf:refs:mixed:string"]),
        "an untyped string should match string and ref values with the same scalar",
      );
      yield* check(
        JSON.stringify(typedEntities) === JSON.stringify(["conf:refs:mixed:ref"]),
        "an explicitly typed ref should match only stored ref values",
      );
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
    name: "conditional transactions are atomic and journal their changes",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const current = yield* t.assert({
        entityId: "conf:conditional:1",
        attribute: ":status",
        value: string("open"),
      });
      const committed = yield* t.transact(
        [
          { op: "retract", id: current.id },
          {
            op: "assert",
            entityId: "conf:conditional:1",
            attribute: ":status",
            value: string("claimed"),
          },
        ],
        {
          actor: "conformance-tester",
          commandId: "conf:claim:1",
          preconditions: [{ _tag: "TripleLive", id: current.id }],
        },
      );
      const conflict = yield* t
        .transact(
          [
            { op: "retract", id: current.id },
            {
              op: "assert",
              entityId: "conf:conditional:1",
              attribute: ":status",
              value: string("cancelled"),
            },
          ],
          { preconditions: [{ _tag: "TripleLive", id: current.id }] },
        )
        .pipe(Effect.flip);
      yield* check(
        conflict instanceof TransactionConflictError,
        "a stale compare-and-retract should report TransactionConflictError",
      );
      const statuses = yield* t.match({
        entityId: "conf:conditional:1",
        attribute: ":status",
      });
      yield* check(
        statuses.length === 1 &&
          statuses[0]!.value.type === "string" &&
          statuses[0]!.value.value === "claimed",
        "a rejected stale transaction must not commit any writes",
      );
      const journal = yield* t.transaction(committed.txId);
      yield* check(
        journal?.position === committed.position &&
          journal.commandId === "conf:claim:1" &&
          journal.changes.length === 2,
        "the transaction journal should retain its causal metadata and changes",
      );
      const page = yield* t.transactions({ after: committed.position - 1, limit: 1 });
      yield* check(
        page.transactions[0]?.txId === committed.txId && page.next === committed.position,
        "transaction journals should be resumable from an ordered commit position",
      );
    }),
  },
  {
    name: "retractByPattern respects entityType",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: "conf:typed-retract:person",
          attribute: ":name",
          value: string("Person"),
          entityType: "Person",
        },
        {
          entityId: "conf:typed-retract:robot",
          attribute: ":name",
          value: string("Robot"),
          entityType: "Robot",
        },
      ]);

      const retracted = yield* t.retractByPattern({ entityType: "Person" });
      const person = yield* t.match({ entityId: "conf:typed-retract:person" });
      const robot = yield* t.match({ entityId: "conf:typed-retract:robot" });
      yield* check(retracted >= 1, "entityType retraction should retract matching facts");
      yield* check(person.length === 0, "entityType retraction should remove matching facts");
      yield* check(robot.length === 1, "entityType retraction must preserve other entity types");

      yield* t.assertBatch([
        {
          entityId: "conf:typed-retract:transaction-person",
          attribute: ":name",
          value: string("Person"),
          entityType: "TransactionPerson",
        },
        {
          entityId: "conf:typed-retract:transaction-robot",
          attribute: ":name",
          value: string("Robot"),
          entityType: "TransactionRobot",
        },
      ]);
      yield* t.transact([{ op: "retract-pattern", pattern: { entityType: "TransactionPerson" } }]);
      const transactionRobot = yield* t.match({
        entityId: "conf:typed-retract:transaction-robot",
      });
      yield* check(
        transactionRobot.length === 1,
        "transaction retract-pattern must preserve other entity types",
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
