import { Schema } from "effect";

export const ValueType = Schema.Literals([
  "string",
  "number",
  "boolean",
  "datetime",
  "ref",
  "json",
  "blob",
]);
export type ValueType = typeof ValueType.Type;

export const StringValue = Schema.Struct({ type: Schema.Literal("string"), value: Schema.String });
export type StringValue = typeof StringValue.Type;

export const NumberValue = Schema.Struct({ type: Schema.Literal("number"), value: Schema.Number });
export type NumberValue = typeof NumberValue.Type;

export const BooleanValue = Schema.Struct({
  type: Schema.Literal("boolean"),
  value: Schema.Boolean,
});
export type BooleanValue = typeof BooleanValue.Type;

export const DateTimeValue = Schema.Struct({
  type: Schema.Literal("datetime"),
  value: Schema.Number,
});
export type DateTimeValue = typeof DateTimeValue.Type;

export const RefValue = Schema.Struct({ type: Schema.Literal("ref"), value: Schema.String });
export type RefValue = typeof RefValue.Type;

export const JsonValue = Schema.Struct({ type: Schema.Literal("json"), value: Schema.Unknown });
export type JsonValue = typeof JsonValue.Type;

export const BlobValue = Schema.Struct({
  type: Schema.Literal("blob"),
  value: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  filename: Schema.optional(Schema.String),
});
export type BlobValue = typeof BlobValue.Type;

export const TripleValue = Schema.Union([
  StringValue,
  NumberValue,
  BooleanValue,
  DateTimeValue,
  RefValue,
  JsonValue,
  BlobValue,
]);
export type TripleValue = typeof TripleValue.Type;

export const string = (value: string): StringValue => ({ type: "string", value });
export const number = (value: number): NumberValue => ({ type: "number", value });
export const boolean = (value: boolean): BooleanValue => ({ type: "boolean", value });
export const datetime = (value: number | Date): DateTimeValue => ({
  type: "datetime",
  value: typeof value === "number" ? value : value.getTime(),
});
export const ref = (entityId: string): RefValue => ({ type: "ref", value: entityId });
export const json = (value: unknown): JsonValue => ({ type: "json", value });
export const blob = (
  hash: string,
  mimeType: string,
  size: number,
  filename?: string,
): BlobValue => ({
  type: "blob",
  value: hash,
  mimeType,
  size,
  ...(filename !== undefined && { filename }),
});
