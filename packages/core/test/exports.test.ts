import { describe, expectTypeOf, it } from "vitest";

import type { DatalogService, DatabaseManagerService, TripleStoreService } from "../src/index.js";

describe("database", () => {
  it("exposes unified database service types", () => {
    expectTypeOf<TripleStoreService>().toBeObject();
    expectTypeOf<DatalogService>().toBeObject();
    expectTypeOf<DatabaseManagerService>().toBeObject();
  });
});
