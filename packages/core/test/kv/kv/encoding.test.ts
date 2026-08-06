import { describe, it, expect } from "vitest";
import {
  compare,
  increment,
  concat,
  fromHex,
  toHex,
  startsWith,
} from "../../../src/kv/kv/encoding.js";

describe("encoding", () => {
  describe("compare", () => {
    it("returns 0 for equal arrays", () => {
      expect(compare(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(0);
    });

    it("returns 0 for empty arrays", () => {
      expect(compare(new Uint8Array([]), new Uint8Array([]))).toBe(0);
    });

    it("returns -1 when a < b by value", () => {
      expect(compare(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(-1);
    });

    it("returns 1 when a > b by value", () => {
      expect(compare(new Uint8Array([1, 2, 4]), new Uint8Array([1, 2, 3]))).toBe(1);
    });

    it("returns -1 when a is a prefix of b", () => {
      expect(compare(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(-1);
    });

    it("returns 1 when b is a prefix of a", () => {
      expect(compare(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(1);
    });

    it("compares first differing byte", () => {
      expect(compare(new Uint8Array([1, 0, 255]), new Uint8Array([1, 1, 0]))).toBe(-1);
    });
  });

  describe("increment", () => {
    it("increments the last byte", () => {
      const result = increment(new Uint8Array([0x01, 0x02]));
      expect(Array.from(result)).toEqual([0x01, 0x03]);
    });

    it("carries over from 0xFF", () => {
      const result = increment(new Uint8Array([0x01, 0xff]));
      expect(Array.from(result)).toEqual([0x02, 0x00]);
    });

    it("handles all 0xFF bytes", () => {
      const result = increment(new Uint8Array([0xff, 0xff]));
      // All bytes overflow -- extends with a leading 0x01
      expect(result.length).toBe(3);
    });

    it("incremented key is always greater than original", () => {
      const original = new Uint8Array([0x01, 0x02, 0x03]);
      const inc = increment(original);
      expect(compare(inc, original)).toBe(1);
    });
  });

  describe("concat", () => {
    it("concatenates multiple arrays", () => {
      const result = concat(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5]));
      expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
    });

    it("handles empty arrays", () => {
      const result = concat(new Uint8Array([]), new Uint8Array([1]));
      expect(Array.from(result)).toEqual([1]);
    });

    it("handles no arguments", () => {
      const result = concat();
      expect(result.length).toBe(0);
    });
  });

  describe("hex conversion", () => {
    it("round-trips through hex", () => {
      const original = new Uint8Array([0x00, 0x0a, 0xff, 0x42]);
      expect(fromHex(toHex(original))).toEqual(original);
    });

    it("encodes to lowercase hex", () => {
      expect(toHex(new Uint8Array([0xab, 0xcd]))).toBe("abcd");
    });
  });

  describe("startsWith", () => {
    it("returns true when key starts with prefix", () => {
      expect(startsWith(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 2]))).toBe(true);
    });

    it("returns true for exact match", () => {
      expect(startsWith(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    });

    it("returns false when key is shorter than prefix", () => {
      expect(startsWith(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    });

    it("returns false when key doesn't match prefix", () => {
      expect(startsWith(new Uint8Array([1, 3, 3, 4]), new Uint8Array([1, 2]))).toBe(false);
    });

    it("returns true for empty prefix", () => {
      expect(startsWith(new Uint8Array([1, 2]), new Uint8Array([]))).toBe(true);
    });
  });
});
