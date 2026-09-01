import { describe, expect, it } from "vitest";
import { Effect, type Layer } from "effect";
import {
  boolean,
  datetime,
  json,
  KvTriples,
  number,
  ref,
  string,
  Triples,
  type DatalogQuery,
  type QueryContext,
} from "@bjacobso/triplex";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";

const corpus: readonly DatalogQuery[] = [
  {
    find: ["?entity", "?code", "?count", "?enabled", "?instant", "?data", "?owner"],
    where: [
      ["?entity", ":diff/code", "?code"],
      ["?entity", ":diff/count", "?count"],
      ["?entity", ":diff/enabled", "?enabled"],
      ["?entity", ":diff/instant", "?instant"],
      ["?entity", ":diff/data", "?data"],
      ["?entity", ":diff/owner", "?owner"],
    ],
  },
  {
    find: ["?left", "?right", "?value"],
    where: [
      ["?left", ":diff/left", "?value"],
      ["?right", ":diff/right", "?value"],
    ],
  },
  {
    find: ["?entity", "?value"],
    where: [
      ["?entity", ":diff/equality", "?value"],
      ["=", "?value", 7],
    ],
  },
  {
    find: ["?entity", "?value"],
    where: [
      ["?entity", ":diff/equality", "?value"],
      ["!=", "?value", 7],
    ],
  },
  {
    find: ["?entity", "?value"],
    where: [
      ["?entity", ":diff/equality", "?value"],
      [">", "?value", 7],
    ],
  },
  {
    find: ["?entity", "?value"],
    where: [
      ["?entity", ":diff/equality", "?value"],
      ["not", ["?excluded", ":diff/excluded", "?value"]],
    ],
  },
  {
    find: ["?entity"],
    where: [["?entity", ":diff/enabled", true]],
  },
  {
    find: ["?dependent"],
    where: [
      ["diff:root", ":diff/child", "?child"],
      ["?dependent", ":diff/child", "?child"],
    ],
  },
  {
    find: ["?entity", "?code", "?count"],
    where: [["?entity", ":_schema/type", "DifferentialThing"]],
    optionalProjection: {
      rowBinding: "?entity",
      fields: [
        { attribute: ":diff/optional-code", variable: "?code" },
        { attribute: ":diff/optional-count", variable: "?count" },
      ],
    },
  },
];

const normalizeRows = (rows: readonly QueryContext[]): readonly string[] =>
  rows
    .map((row) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(row).sort(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    )
    .sort();

const runCorpus = Effect.gen(function* () {
  const triples = yield* Triples;
  yield* triples.assertBatch([
    { entityId: "42", attribute: ":diff/code", value: string("007") },
    { entityId: "42", attribute: ":diff/count", value: number(7) },
    { entityId: "42", attribute: ":diff/enabled", value: boolean(true) },
    { entityId: "42", attribute: ":diff/instant", value: datetime(1_700_000_000_000) },
    { entityId: "42", attribute: ":diff/data", value: json({ ok: true }) },
    { entityId: "42", attribute: ":diff/owner", value: ref("7") },
    { entityId: "diff:left:number", attribute: ":diff/left", value: number(7) },
    { entityId: "diff:right:number", attribute: ":diff/right", value: number(7) },
    { entityId: "diff:left:string", attribute: ":diff/left", value: string("7") },
    { entityId: "diff:right:string", attribute: ":diff/right", value: string("7") },
    { entityId: "diff:right:other", attribute: ":diff/right", value: number(8) },
    { entityId: "diff:eq:number", attribute: ":diff/equality", value: number(7) },
    { entityId: "diff:eq:datetime", attribute: ":diff/equality", value: datetime(7) },
    { entityId: "diff:eq:string", attribute: ":diff/equality", value: string("7") },
    { entityId: "diff:eq:other", attribute: ":diff/equality", value: number(8) },
    { entityId: "diff:excluded", attribute: ":diff/excluded", value: number(7) },
    { entityId: "diff:root", attribute: ":diff/child", value: ref("diff:leaf") },
    { entityId: "diff:sibling", attribute: ":diff/child", value: ref("diff:leaf") },
    {
      entityId: "diff:optional",
      attribute: ":_schema/type",
      value: string("DifferentialThing"),
    },
    { entityId: "diff:optional", attribute: ":diff/optional-code", value: string("007") },
    { entityId: "diff:optional", attribute: ":diff/optional-count", value: number(7) },
  ]);

  return yield* Effect.forEach(corpus, (query) =>
    triples.query(query).pipe(Effect.map(({ results }) => normalizeRows(results))),
  );
});

const runWith = (layer: Layer.Layer<Triples, unknown, never>) =>
  Effect.runPromise(runCorpus.pipe(Effect.provide(layer)));

describe("Datalog backend differential corpus", () => {
  it("returns identical typed bindings from KV and SQLite", async () => {
    const [kv, sqlite] = await Promise.all([
      runWith(KvTriples.layer),
      runWith(SqliteTriples.layerMemory),
    ]);

    expect(sqlite).toEqual(kv);
  });
});
