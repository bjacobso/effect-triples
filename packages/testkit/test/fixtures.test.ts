import { describe, expect, it } from "vitest";

import { defineBackendFixture, expectBackendCapability } from "../src/index.js";

describe("database-testkit", () => {
  it("defines lightweight backend fixtures", () => {
    const fixture = defineBackendFixture({
      name: "sqlite",
      capabilities: ["transactions", "history"],
    });

    expect(fixture.name).toBe("sqlite");
    expect(expectBackendCapability(fixture, "transactions")).toBe(true);
    expect(expectBackendCapability(fixture, "changefeed")).toBe(false);
  });
});
