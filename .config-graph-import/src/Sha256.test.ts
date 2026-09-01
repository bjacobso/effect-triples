import { createHash } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";

import * as Sha256 from "./Sha256";

/** The oracle. Tests run on Node, so the reference implementation is available. */
const reference = (input: string) =>
  createHash("sha256").update(input, "utf8").digest("hex");

describe("Sha256", () => {
  it("matches the published vectors", () => {
    expect(Sha256.hex("")).toEqual(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(Sha256.hex("abc")).toEqual(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("agrees with node:crypto on the block-boundary cases", () => {
    // Padding is where a hand-written implementation goes wrong: one byte short
    // of a block, exactly full, and one over.
    const lengths = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129];
    for (const length of lengths) {
      const input = "a".repeat(length);
      expect(Sha256.hex(input), `length ${length}`).toEqual(reference(input));
    }
  });

  it("agrees on multi-byte UTF-8, since the encoding is part of the hash", () => {
    for (const input of ["e", "é", "日本語", "naive cafe"]) {
      expect(Sha256.hex(input), input).toEqual(reference(input));
    }
  });

  it("agrees over random inputs", () => {
    // Deterministic PRNG: a test that hashes differently on each run cannot be
    // debugged from its failure message.
    let seed = 0x2f6e2b1;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);

    for (let i = 0; i < 300; i++) {
      const length = next() % 200;
      let input = "";
      for (let j = 0; j < length; j++) {
        input += String.fromCharCode(next() % 0x2000);
      }
      expect(Sha256.hex(input), JSON.stringify(input)).toEqual(
        reference(input)
      );
    }
  });

  it("agrees on a payload larger than any realistic config node", () => {
    const big = "x".repeat(100_000);
    expect(Sha256.hex(big)).toEqual(reference(big));
  });
});
