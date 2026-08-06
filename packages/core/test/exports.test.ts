import { describe, expectTypeOf, it } from "vitest";

import type { DatabaseManagerService, TriplesService } from "../src/index.js";

describe("database", () => {
  it("exposes unified database service types", () => {
    expectTypeOf<TriplesService>().toBeObject();
    expectTypeOf<DatabaseManagerService>().toBeObject();
  });
});
