import { describe, expectTypeOf, it } from "vitest";

import type { SqliteDialect, SqliteBackendLive } from "../src/index.js";

describe("database-sqlite", () => {
  it("exposes sqlite backend wiring types through the database package", () => {
    expectTypeOf<SqliteDialect>().toBeObject();
    expectTypeOf<typeof SqliteBackendLive>().toBeObject();
  });
});
