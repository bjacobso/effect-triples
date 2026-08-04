// Filter types for query builder
export type Filter =
  | { readonly type: "eq"; readonly attribute: string; readonly value: unknown }
  | { readonly type: "neq"; readonly attribute: string; readonly value: unknown }
  | { readonly type: "gt"; readonly attribute: string; readonly value: number }
  | { readonly type: "gte"; readonly attribute: string; readonly value: number }
  | { readonly type: "lt"; readonly attribute: string; readonly value: number }
  | { readonly type: "lte"; readonly attribute: string; readonly value: number }
  | { readonly type: "contains"; readonly attribute: string; readonly value: string }
  | { readonly type: "startsWith"; readonly attribute: string; readonly value: string }
  | { readonly type: "exists"; readonly attribute: string }
  | { readonly type: "notExists"; readonly attribute: string }
  | { readonly type: "in"; readonly attribute: string; readonly values: readonly unknown[] }
  | { readonly type: "and"; readonly filters: readonly Filter[] }
  | { readonly type: "or"; readonly filters: readonly Filter[] }
  | { readonly type: "not"; readonly filter: Filter };

// Sort specification
export interface SortSpec {
  readonly attribute: string;
  readonly direction: "asc" | "desc";
  readonly nulls?: "first" | "last";
}

// Filter constructors
export const eq = (attribute: string, value: unknown): Filter => ({ type: "eq", attribute, value });
export const neq = (attribute: string, value: unknown): Filter => ({
  type: "neq",
  attribute,
  value,
});
export const gt = (attribute: string, value: number): Filter => ({ type: "gt", attribute, value });
export const gte = (attribute: string, value: number): Filter => ({
  type: "gte",
  attribute,
  value,
});
export const lt = (attribute: string, value: number): Filter => ({ type: "lt", attribute, value });
export const lte = (attribute: string, value: number): Filter => ({
  type: "lte",
  attribute,
  value,
});
export const contains = (attribute: string, value: string): Filter => ({
  type: "contains",
  attribute,
  value,
});
export const startsWith = (attribute: string, value: string): Filter => ({
  type: "startsWith",
  attribute,
  value,
});
export const exists = (attribute: string): Filter => ({ type: "exists", attribute });
export const notExists = (attribute: string): Filter => ({ type: "notExists", attribute });
export const isIn = (attribute: string, values: readonly unknown[]): Filter => ({
  type: "in",
  attribute,
  values,
});
export const and = (...filters: readonly Filter[]): Filter => ({ type: "and", filters });
export const or = (...filters: readonly Filter[]): Filter => ({ type: "or", filters });
export const not = (filter: Filter): Filter => ({ type: "not", filter });
