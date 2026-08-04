import { defineConfig } from "vitest/config";
import path from "node:path";

const dbSrc = path.resolve(__dirname, "src");
const dbSqlSrc = path.resolve(__dirname, "sql/src");

export default defineConfig({
  resolve: {
    alias: [
      // Sibling package resolution: @open-ontology/database-sql -> ./sql/src
      { find: "@open-ontology/database-sql", replacement: `${dbSqlSrc}/index.ts` },
      // Self-reference resolution: @open-ontology/database -> ./src
      { find: /^@open-ontology\/database\/(.+)$/, replacement: `${dbSrc}/$1.ts` },
      { find: "@open-ontology/database", replacement: `${dbSrc}/index.ts` },
    ],
  },
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
