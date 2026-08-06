import { describe, expectTypeOf, it } from "vitest";

import type { DOContext } from "../src/services/index.js";

type SupportExports = typeof import("../src/adapter-support.js");
type RootExports = typeof import("../src/index.js");

describe("database-cloudflare", () => {
  it("exposes cloudflare database wiring types", () => {
    expectTypeOf<DOContext>().toBeObject();
  });

  it("exposes cloudflare adapter sql helper types", () => {
    expectTypeOf<SupportExports["packValue"]>().toBeFunction();
    expectTypeOf<SupportExports["TRIPLES_TABLE_DDL"]>().toEqualTypeOf<string>();
    expectTypeOf<SupportExports["MIGRATIONS_TABLE_DDL"]>().toEqualTypeOf<string>();
    expectTypeOf<SupportExports["INDEX_DDLS"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<SupportExports["migrations"]>().toEqualTypeOf<
      readonly { version: number; name: string; up: string }[]
    >();
  });

  it("re-exports cloudflare adapter helpers from the package root", () => {
    expectTypeOf<RootExports["packValue"]>().toEqualTypeOf<SupportExports["packValue"]>();
    expectTypeOf<RootExports["TRIPLES_TABLE_DDL"]>().toEqualTypeOf<string>();
    expectTypeOf<RootExports["migrations"]>().toEqualTypeOf<SupportExports["migrations"]>();
  });
});
