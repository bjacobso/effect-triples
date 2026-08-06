import { describe, expect, it } from "vitest";

import { makeFdbKvBackend } from "../src/index.js";

describe("database-foundationdb", () => {
  it("exposes foundationdb backend wiring through the database package", () => {
    expect(makeFdbKvBackend).toBeDefined();
  });
});
