/**
 * Framework layer: the shape of an id and the separation between hash domains.
 */

import { describe, expect, it } from "@effect/vitest";

import * as ContentId from "../../src/content/ContentId";

describe("ContentId", () => {
  it("renders a self-describing, algorithm-tagged id", () => {
    expect(ContentId.hash("test", "payload")).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(ContentId.isContentId(ContentId.hash("test", "payload"))).toBe(true);
  });

  it("separates domains so a node id cannot be forged from a blob id", () => {
    expect(ContentId.hash("a", "x")).not.toEqual(ContentId.hash("b", "x"));
    // The length prefix stops the domain and payload from being reflowed into
    // each other: hash("ab", "c") must not equal hash("a", "bc").
    expect(ContentId.hash("ab", "c")).not.toEqual(ContentId.hash("a", "bc"));
  });
});
