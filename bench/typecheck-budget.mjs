/**
 * The TypeScript budget gate.
 *
 * Three RFCs (requirement-kernel, effect-domain-dsl, domain-expression-algebra)
 * gate Phase 0 on compile cost measured "against a fixture at least as large as
 * a real account policy catalog", and each names inference collapse at scale as
 * a risk. A gate nobody can re-run is a gate that rots, so this generates the
 * fixture, measures, and cleans up after itself.
 *
 * The number that matters is not the absolute time - it is the ATTRIBUTION.
 * `schema-only` and `entity-only` isolate each builder; `combined` is what real
 * authoring looks like. If combined is far above their sum, the cost is in the
 * interaction between `Entity.make`'s generics and a distinct inferred
 * `Schema.Schema<A, I>` per entity, not in either builder alone.
 *
 *   node bench/typecheck-budget.mjs [sizes...]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, ".generated");
const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const SIZES = sizes.length > 0 ? sizes : [300];

const attrs = (i) => `const Attrs${i} = Schema.Struct({
  slug: Schema.String, name: Schema.String,
  status: Schema.Literal("draft", "published", "deprecated"),
  count: Schema.Number, flag: Schema.optional(Schema.Boolean),
  tags: Schema.Array(Schema.String),
  nested: Schema.Struct({ a: Schema.String, b: Schema.Number }),
});`;

const entity = (i, n, schema) => `export const Entity${i} = Entity.make({
  kind: Kind${i}, attrs: ${schema}, key: (a) => a.slug,
  children: { child: Entity.children(Kind${(i + 1) % n}) },
  refs: { uses: Entity.ref(AttrKind), links: Entity.ref(Kind${(i + 2) % n}) },
});`;

const fixtures = {
  // Effect Schema inference alone.
  "schema-only": (n) =>
    [
      `import { Schema } from "effect";`,
      ...Array.from({ length: n }, (_, i) => `export ${attrs(i)}`),
    ].join("\n"),
  // Entity.make generics alone: every entity shares one schema type, so
  // TypeScript instantiates the generic once. This is also the shape the API
  // would have if `attrs` were a plain `TypeExpr` value instead of a Schema.
  "entity-only": (n) =>
    [
      `import { Schema } from "effect";`,
      `import * as Entity from "../../src/Entity";`,
      `const AttrKind = Entity.kind("attribute");`,
      `const Shared = Schema.Struct({ slug: Schema.String });`,
      ...Array.from(
        { length: n },
        (_, i) => `const Kind${i} = Entity.kind("entity${i}");`
      ),
      ...Array.from({ length: n }, (_, i) => entity(i, n, "Shared")),
    ].join("\n"),
  // What authoring actually looks like today.
  combined: (n) =>
    [
      `import { Schema } from "effect";`,
      `import * as Entity from "../../src/Entity";`,
      `const AttrKind = Entity.kind("attribute");`,
      ...Array.from(
        { length: n },
        (_, i) => `const Kind${i} = Entity.kind("entity${i}");`
      ),
      ...Array.from(
        { length: n },
        (_, i) => `${attrs(i)}\n${entity(i, n, `Attrs${i}`)}`
      ),
    ].join("\n"),
};

const time = (include) => {
  writeFileSync(
    join(DIR, "tsconfig.json"),
    JSON.stringify({
      extends: "../../tsconfig.json",
      compilerOptions: { rootDir: "../..", noEmit: true },
      include: [include, "../../src/**/*"],
    })
  );
  const start = process.hrtime.bigint();
  try {
    execFileSync(
      "pnpm",
      ["exec", "tsc", "-p", join(DIR, "tsconfig.json"), "--noEmit"],
      { stdio: "pipe" }
    );
  } catch (error) {
    console.error(String(error.stdout ?? error).slice(0, 400));
    throw new Error(`typecheck failed for ${include}`);
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
};

mkdirSync(DIR, { recursive: true });
try {
  writeFileSync(join(DIR, "empty.ts"), "export {};\n");
  const baseline = time("./empty.ts");
  console.log(
    `baseline (src only)      ${baseline.toFixed(0).padStart(6)} ms\n`
  );

  for (const n of SIZES) {
    console.log(`--- ${n} declarations ---`);
    const marginal = {};
    for (const [name, make] of Object.entries(fixtures)) {
      writeFileSync(join(DIR, `${name}.ts`), make(n));
      marginal[name] = time(`./${name}.ts`) - baseline;
      console.log(
        `  ${name.padEnd(22)} +${marginal[name].toFixed(0).padStart(5)} ms`
      );
    }
    const parts = marginal["schema-only"] + marginal["entity-only"];
    console.log(
      `  ${"sum of parts".padEnd(22)} +${parts.toFixed(0).padStart(5)} ms`
    );
    console.log(
      `  interaction factor      ${(marginal.combined / parts).toFixed(1)}x\n`
    );
  }
} finally {
  rmSync(DIR, { recursive: true, force: true });
}
