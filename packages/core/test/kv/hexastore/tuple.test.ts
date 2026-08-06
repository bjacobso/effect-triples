import { describe, it, expect } from "vitest";
import {
  encodeTuple,
  decodeTuple,
  tNull,
  tBoolean,
  tNumber,
  tString,
  tRef,
  tDatetime,
  tJson,
  tBlob,
  tMax,
  TAG_NULL,
  TAG_BOOLEAN,
  TAG_NUMBER,
  TAG_STRING,
  TAG_REF,
  TAG_DATETIME,
  TAG_JSON,
  TAG_BLOB,
  TAG_MAX,
  type TuplePart,
} from "../../../src/kv/hexastore/tuple.js";
import { compare } from "../../../src/kv/kv/encoding.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Encode a single part for comparison. */
const encode1 = (part: TuplePart): Uint8Array => encodeTuple(part);

/** Lexicographic comparison of encoded tuple parts. */
const cmp = (a: TuplePart, b: TuplePart): number => compare(encode1(a), encode1(b));

// ─── Roundtrip tests ───────────────────────────────────────────────────────

describe("tuple encoding roundtrip", () => {
  it("null roundtrips", () => {
    const encoded = encodeTuple(tNull());
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "null" }]);
  });

  it("boolean false roundtrips", () => {
    const encoded = encodeTuple(tBoolean(false));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "boolean", value: false }]);
  });

  it("boolean true roundtrips", () => {
    const encoded = encodeTuple(tBoolean(true));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "boolean", value: true }]);
  });

  it("positive number roundtrips", () => {
    const encoded = encodeTuple(tNumber(42.5));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "number", value: 42.5 }]);
  });

  it("negative number roundtrips", () => {
    const encoded = encodeTuple(tNumber(-100.25));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "number", value: -100.25 }]);
  });

  it("zero roundtrips", () => {
    const encoded = encodeTuple(tNumber(0));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "number", value: 0 }]);
  });

  it("negative zero roundtrips preserving sign", () => {
    const encoded = encodeTuple(tNumber(-0));
    const decoded = decodeTuple(encoded);
    expect(decoded[0]!.type).toBe("number");
    const val = (decoded[0] as { type: "number"; value: number }).value;
    // IEEE 754: -0 is preserved through sign-flip encoding
    expect(Object.is(val, -0)).toBe(true);
  });

  it("Infinity roundtrips", () => {
    const encoded = encodeTuple(tNumber(Infinity));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "number", value: Infinity }]);
  });

  it("-Infinity roundtrips", () => {
    const encoded = encodeTuple(tNumber(-Infinity));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "number", value: -Infinity }]);
  });

  it("simple string roundtrips", () => {
    const encoded = encodeTuple(tString("hello world"));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "string", value: "hello world" }]);
  });

  it("empty string roundtrips", () => {
    const encoded = encodeTuple(tString(""));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "string", value: "" }]);
  });

  it("string with null bytes roundtrips", () => {
    const encoded = encodeTuple(tString("a\x00b\x00c"));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "string", value: "a\x00b\x00c" }]);
  });

  it("ref roundtrips", () => {
    const encoded = encodeTuple(tRef("emp:alice"));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "ref", value: "emp:alice" }]);
  });

  it("datetime roundtrips", () => {
    const ts = Date.now();
    const encoded = encodeTuple(tDatetime(ts));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "datetime", value: ts }]);
  });

  it("json roundtrips", () => {
    const data = { key: "value", nested: [1, 2, 3] };
    const encoded = encodeTuple(tJson(data));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "json", value: data }]);
  });

  it("blob roundtrips", () => {
    const hash = "abc123deadbeef";
    const encoded = encodeTuple(tBlob(hash));
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "blob", value: hash }]);
  });

  it("max roundtrips", () => {
    const encoded = encodeTuple(tMax());
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([{ type: "max" }]);
  });

  it("multi-part tuple roundtrips", () => {
    const parts: TuplePart[] = [
      tString("entity:1"),
      tString(":person/name"),
      tNumber(42),
      tString("tx:100"),
    ];
    const encoded = encodeTuple(...parts);
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual(parts);
  });

  it("empty tuple encodes to empty bytes", () => {
    const encoded = encodeTuple();
    expect(encoded.length).toBe(0);
    const decoded = decodeTuple(encoded);
    expect(decoded).toEqual([]);
  });
});

// ─── Sort order tests ──────────────────────────────────────────────────────

describe("tuple encoding sort order", () => {
  it("null < boolean < number < string < ref < datetime < json < blob < max", () => {
    // Types sort by their tag byte
    expect(cmp(tNull(), tBoolean(false))).toBeLessThan(0);
    expect(cmp(tBoolean(true), tNumber(0))).toBeLessThan(0);
    expect(cmp(tNumber(999), tString(""))).toBeLessThan(0);
    expect(cmp(tString("zzz"), tRef(""))).toBeLessThan(0);
    expect(cmp(tRef("zzz"), tDatetime(0))).toBeLessThan(0);
    expect(cmp(tDatetime(Number.MAX_SAFE_INTEGER), tJson(null))).toBeLessThan(0);
    expect(cmp(tJson({ z: 999 }), tBlob("zzz"))).toBeLessThan(0);
    expect(cmp(tBlob("zzz"), tMax())).toBeLessThan(0);
  });

  it("false < true for booleans", () => {
    expect(cmp(tBoolean(false), tBoolean(true))).toBeLessThan(0);
  });

  it("numbers sort correctly: negative < zero < positive", () => {
    expect(cmp(tNumber(-1000), tNumber(-1))).toBeLessThan(0);
    expect(cmp(tNumber(-1), tNumber(0))).toBeLessThan(0);
    expect(cmp(tNumber(0), tNumber(1))).toBeLessThan(0);
    expect(cmp(tNumber(1), tNumber(1000))).toBeLessThan(0);
  });

  it("special number ordering: -Inf < -1 < 0 < 1 < +Inf", () => {
    expect(cmp(tNumber(-Infinity), tNumber(-1))).toBeLessThan(0);
    expect(cmp(tNumber(-1), tNumber(0))).toBeLessThan(0);
    expect(cmp(tNumber(0), tNumber(1))).toBeLessThan(0);
    expect(cmp(tNumber(1), tNumber(Infinity))).toBeLessThan(0);
  });

  it("fractional numbers sort correctly", () => {
    expect(cmp(tNumber(1.1), tNumber(1.2))).toBeLessThan(0);
    expect(cmp(tNumber(-1.2), tNumber(-1.1))).toBeLessThan(0);
  });

  it("strings sort lexicographically", () => {
    expect(cmp(tString("a"), tString("b"))).toBeLessThan(0);
    expect(cmp(tString("abc"), tString("abd"))).toBeLessThan(0);
    expect(cmp(tString(""), tString("a"))).toBeLessThan(0);
  });

  it("shorter string < longer string when prefix matches", () => {
    // "abc" should sort before "abcd" because the null terminator
    // [0x00, 0x00] sorts before the 'd' byte
    expect(cmp(tString("abc"), tString("abcd"))).toBeLessThan(0);
  });

  it("refs sort like strings within their tag", () => {
    expect(cmp(tRef("a"), tRef("b"))).toBeLessThan(0);
    expect(cmp(tRef("emp:1"), tRef("emp:2"))).toBeLessThan(0);
  });

  it("datetimes sort chronologically", () => {
    const earlier = 1700000000000;
    const later = 1700000001000;
    expect(cmp(tDatetime(earlier), tDatetime(later))).toBeLessThan(0);
  });

  it("multi-part tuples sort element by element", () => {
    // Same first part, different second part
    const a = encodeTuple(tString("alice"), tNumber(1));
    const b = encodeTuple(tString("alice"), tNumber(2));
    expect(compare(a, b)).toBeLessThan(0);

    // Different first part — second part doesn't matter
    const c = encodeTuple(tString("alice"), tNumber(999));
    const d = encodeTuple(tString("bob"), tNumber(1));
    expect(compare(c, d)).toBeLessThan(0);
  });

  it("equal values compare as equal", () => {
    expect(cmp(tNumber(42), tNumber(42))).toBe(0);
    expect(cmp(tString("hello"), tString("hello"))).toBe(0);
    expect(cmp(tBoolean(true), tBoolean(true))).toBe(0);
  });
});

// ─── Tag values ────────────────────────────────────────────────────────────

describe("tuple type tags", () => {
  it("tags are in ascending order", () => {
    expect(TAG_NULL).toBeLessThan(TAG_BOOLEAN);
    expect(TAG_BOOLEAN).toBeLessThan(TAG_NUMBER);
    expect(TAG_NUMBER).toBeLessThan(TAG_STRING);
    expect(TAG_STRING).toBeLessThan(TAG_REF);
    expect(TAG_REF).toBeLessThan(TAG_DATETIME);
    expect(TAG_DATETIME).toBeLessThan(TAG_JSON);
    expect(TAG_JSON).toBeLessThan(TAG_BLOB);
    expect(TAG_BLOB).toBeLessThan(TAG_MAX);
  });

  it("first byte of encoded part is the tag", () => {
    expect(encode1(tNull())[0]).toBe(TAG_NULL);
    expect(encode1(tBoolean(true))[0]).toBe(TAG_BOOLEAN);
    expect(encode1(tNumber(1))[0]).toBe(TAG_NUMBER);
    expect(encode1(tString("x"))[0]).toBe(TAG_STRING);
    expect(encode1(tRef("x"))[0]).toBe(TAG_REF);
    expect(encode1(tDatetime(1))[0]).toBe(TAG_DATETIME);
    expect(encode1(tJson(null))[0]).toBe(TAG_JSON);
    expect(encode1(tBlob("x"))[0]).toBe(TAG_BLOB);
    expect(encode1(tMax())[0]).toBe(TAG_MAX);
  });
});
