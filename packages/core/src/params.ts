/**
 * ParamCollector - SQL parameter collection utility.
 */

import type { SqlDialect } from "./dialects/types.js";

export interface ParamCollector {
  readonly dialect: SqlDialect;
  readonly params: readonly unknown[];
  add(value: unknown): string;
  result(): { params: readonly unknown[] };
}

export const createParamCollector = (dialect: SqlDialect): ParamCollector => {
  const params: unknown[] = [];

  return {
    dialect,
    get params() {
      return params;
    },
    add(value: unknown): string {
      const converted = typeof value === "boolean" ? (value ? 1 : 0) : value;
      params.push(converted);
      return dialect.paramPlaceholder(params.length - 1);
    },
    result() {
      return { params: [...params] };
    },
  };
};
