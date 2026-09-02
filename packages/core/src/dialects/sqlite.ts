import type { SqlDialect } from "./types.js";

/**
 * Default SQLite dialect for datalog compilation.
 * Backend-specific dialects can override at runtime via CurrentDialect.
 */
export const SqliteDialect: SqlDialect = {
  name: "sqlite",
  limitOffset: (limit, offset) => {
    const parts: string[] = [];
    if (limit !== undefined) parts.push(`LIMIT ${limit}`);
    if (offset !== undefined && offset > 0) {
      if (limit === undefined) parts.push("LIMIT -1");
      parts.push(`OFFSET ${offset}`);
    }
    return parts.join(" ");
  },
  castAsText: (expression) => `CAST(${expression} AS TEXT)`,
  booleanLiteral: (value) => (value ? "1" : "0"),
  // Numbered parameters preserve collector identity when SELECT projections
  // are compiled after WHERE/JOIN clauses but appear earlier in SQL text.
  paramPlaceholder: (index) => `?${index + 1}`,
  escapeLikePattern: (value) => value.replace(/[%_\\]/g, "\\$&"),
};
