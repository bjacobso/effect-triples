/**
 * Framework layer. Nothing here knows what a form is - these are properties of
 * the encoding itself, and they are what every content id downstream rests on.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as CanonicalJson from "./CanonicalJson";

describe("CanonicalJson", () => {
  it.effect("is insensitive to object key order at any depth", () =>
    Effect.gen(function* () {
      const a = yield* CanonicalJson.encode({
        b: { y: 1, x: [{ q: true, p: null }] },
        a: "z",
      });
      const b = yield* CanonicalJson.encode({
        a: "z",
        b: { x: [{ p: null, q: true }], y: 1 },
      });
      expect(a).toEqual(b);
      expect(a).toEqual('{"a":"z","b":{"x":[{"p":null,"q":true}],"y":1}}');
    })
  );

  it.effect("drops undefined properties but keeps undefined array slots", () =>
    Effect.gen(function* () {
      expect(yield* CanonicalJson.encode({ a: 1, b: undefined })).toEqual(
        yield* CanonicalJson.encode({ a: 1 })
      );
      expect(yield* CanonicalJson.encode([1, undefined, 2])).toEqual(
        "[1,null,2]"
      );
    })
  );

  it.effect("normalises -0 so it shares a hash with 0", () =>
    Effect.gen(function* () {
      expect(yield* CanonicalJson.encode({ n: -0 })).toEqual('{"n":0}');
    })
  );

  it.effect("rejects values with no stable encoding", () =>
    Effect.gen(function* () {
      const reasons = yield* Effect.all(
        [
          { deep: { bad: Number.NaN } },
          { at: new Date(0) },
          { fn: (() => 1) as never },
        ].map((value) =>
          CanonicalJson.encode(value as CanonicalJson.CanonicalValue).pipe(
            Effect.flip,
            Effect.map((error) => `${error.reason} @ ${error.path}`)
          )
        )
      );

      expect(reasons).toEqual([
        "non_finite_number @ deep.bad",
        "unsupported_type @ at",
        "unsupported_type @ fn",
      ]);
    })
  );

  it.effect("rejects cycles rather than looping forever", () =>
    Effect.gen(function* () {
      const cyclic: Record<string, unknown> = { name: "a" };
      cyclic.self = cyclic;

      const error = yield* CanonicalJson.encode(
        cyclic as CanonicalJson.CanonicalValue
      ).pipe(Effect.flip);

      expect(error.reason).toEqual("circular_reference");
      expect(error.path).toEqual("self");
    })
  );
});
