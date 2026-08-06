import { Effect } from "effect";
import { KvTriples, Triples, number, ref, string } from "effect-triples";

const program = Effect.gen(function* () {
  const triples = yield* Triples;

  yield* triples.assertBatch([
    {
      entityId: "person:alice",
      attribute: ":person/name",
      value: string("Alice"),
    },
    {
      entityId: "person:alice",
      attribute: ":person/age",
      value: number(34),
    },
    {
      entityId: "person:alice",
      attribute: ":person/friend",
      value: ref("person:bob"),
    },
    {
      entityId: "person:bob",
      attribute: ":person/name",
      value: string("Bob"),
    },
    {
      entityId: "person:bob",
      attribute: ":person/age",
      value: number(28),
    },
  ]);

  const aliceFacts = yield* triples.match({ entityId: "person:alice" });

  const { results: adults } = yield* triples.query({
    find: ["?name", "?age"],
    where: [
      ["?person", ":person/name", "?name"],
      ["?person", ":person/age", "?age"],
      [">=", "?age", 30],
    ],
  });

  const { results: friends } = yield* triples.query({
    find: ["?personName", "?friendName"],
    where: [
      ["?person", ":person/name", "?personName"],
      ["?person", ":person/friend", "?friend"],
      ["?friend", ":person/name", "?friendName"],
    ],
  });

  return { aliceFacts, adults, friends };
});

const result = await Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer)));

console.log("Alice's facts:", result.aliceFacts);
console.log("People aged 30 or older:", result.adults);
console.log("Friend relationships:", result.friends);
