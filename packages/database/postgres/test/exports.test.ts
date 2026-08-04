import { describe, expectTypeOf, it } from "vitest";

import type { PostgresqlDialect, makePostgresqlBackendFromUrl } from "../src/index.js";

describe("database-postgres", () => {
  it("exposes postgres backend wiring types through the database package", () => {
    expectTypeOf<PostgresqlDialect>().toBeObject();
    expectTypeOf<typeof makePostgresqlBackendFromUrl>().toBeFunction();
  });
});
