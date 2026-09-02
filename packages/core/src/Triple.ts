import { Schema } from "effect";
import { TripleValue } from "./Value.js";
import { TripleId, EntityId, Attribute } from "./Branded.js";

export { TripleId, EntityId, Attribute };

export const TripleInput = Schema.Struct({
  entityId: Schema.String,
  attribute: Schema.String,
  value: TripleValue,
  entityType: Schema.optional(Schema.String),
  createdBy: Schema.optional(Schema.String),
  validFrom: Schema.optional(Schema.Number),
  validTo: Schema.optional(Schema.Number),
});
export type TripleInput = typeof TripleInput.Type;

export const QueryRequest = Schema.Struct({
  entityId: Schema.optional(Schema.String),
  attribute: Schema.optional(Schema.String),
  entityType: Schema.optional(Schema.String),
  value: Schema.optional(TripleValue),
});
export type QueryRequest = typeof QueryRequest.Type;

export const QueryAsOfRequest = Schema.Struct({
  entityId: Schema.optional(Schema.String),
  attribute: Schema.optional(Schema.String),
  entityType: Schema.optional(Schema.String),
  value: Schema.optional(TripleValue),
  asOf: Schema.Number,
});
export type QueryAsOfRequest = typeof QueryAsOfRequest.Type;

export const AssertTripleRequest = Schema.Union([TripleInput, Schema.Array(TripleInput)]);
export type AssertTripleRequest = typeof AssertTripleRequest.Type;

export const RetractResponse = Schema.Struct({ retracted: Schema.Number });
export type RetractResponse = typeof RetractResponse.Type;

export const TripleResponse = Schema.Struct({
  id: Schema.String,
  entityId: Schema.String,
  attribute: Schema.String,
  value: TripleValue,
  createdAt: Schema.Number,
  recordedAt: Schema.Number,
  validFrom: Schema.Number,
  validTo: Schema.NullOr(Schema.Number),
  createdBy: Schema.NullOr(Schema.String),
  retractedAt: Schema.NullOr(Schema.Number),
  recordedRetractedAt: Schema.NullOr(Schema.Number),
  entityType: Schema.NullOr(Schema.String),
  schemaVersion: Schema.NullOr(Schema.Number),
  txId: Schema.NullOr(Schema.String),
  retractTxId: Schema.NullOr(Schema.String),
});
export type TripleResponse = typeof TripleResponse.Type;

export const Triple = Schema.Struct({
  id: TripleId,
  entityId: EntityId,
  attribute: Attribute,
  value: TripleValue,
  createdAt: Schema.Number,
  recordedAt: Schema.Number,
  validFrom: Schema.Number,
  validTo: Schema.OptionFromOptional(Schema.Number),
  createdBy: Schema.OptionFromOptional(Schema.String),
  retractedAt: Schema.OptionFromOptional(Schema.Number),
  recordedRetractedAt: Schema.OptionFromOptional(Schema.Number),
  entityType: Schema.OptionFromOptional(Schema.String),
  schemaVersion: Schema.OptionFromOptional(Schema.Number),
  txId: Schema.OptionFromOptional(Schema.String),
  retractTxId: Schema.OptionFromOptional(Schema.String),
});
export type Triple = typeof Triple.Type;

export const TripleRow = Schema.Struct({
  id: Schema.String,
  entity_id: Schema.String,
  attribute: Schema.String,
  value_type: Schema.String,
  value_string: Schema.NullOr(Schema.String),
  value_number: Schema.NullOr(Schema.Number),
  value_boolean: Schema.NullOr(Schema.Number),
  value_datetime: Schema.NullOr(Schema.Number),
  value_json: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  recorded_at: Schema.Number,
  recorded_position: Schema.NullOr(Schema.Number),
  valid_from: Schema.Number,
  valid_to: Schema.NullOr(Schema.Number),
  created_by: Schema.NullOr(Schema.String),
  retracted_at: Schema.NullOr(Schema.Number),
  recorded_retracted_at: Schema.NullOr(Schema.Number),
  recorded_retracted_position: Schema.NullOr(Schema.Number),
  retract_tx_id: Schema.NullOr(Schema.String),
  entity_type: Schema.NullOr(Schema.String),
  schema_version: Schema.NullOr(Schema.Number),
  tx_id: Schema.NullOr(Schema.String),
});
export type TripleRow = typeof TripleRow.Type;

export const TransactAssertOp = Schema.Struct({
  op: Schema.Literal("assert"),
  entityId: Schema.String,
  attribute: Schema.String,
  value: TripleValue,
  entityType: Schema.optional(Schema.String),
  createdBy: Schema.optional(Schema.String),
  validFrom: Schema.optional(Schema.Number),
  validTo: Schema.optional(Schema.Number),
});
export type TransactAssertOp = typeof TransactAssertOp.Type;

export const TransactRetractOp = Schema.Struct({
  op: Schema.Literal("retract"),
  id: Schema.String,
});
export type TransactRetractOp = typeof TransactRetractOp.Type;

export const TransactRetractPatternOp = Schema.Struct({
  op: Schema.Literal("retract-pattern"),
  pattern: QueryRequest,
});
export type TransactRetractPatternOp = typeof TransactRetractPatternOp.Type;

export const TransactOp = Schema.Union([
  TransactAssertOp,
  TransactRetractOp,
  TransactRetractPatternOp,
]);
export type TransactOp = typeof TransactOp.Type;

export const TransactionPrecondition = Schema.Struct({
  _tag: Schema.Literal("TripleLive"),
  id: Schema.String,
});
export type TransactionPrecondition = typeof TransactionPrecondition.Type;

export const TransactRequest = Schema.Struct({
  operations: Schema.Array(TransactOp),
  meta: Schema.optional(
    Schema.Struct({
      user: Schema.optional(Schema.String),
      actor: Schema.optional(Schema.String),
      commandId: Schema.optional(Schema.String),
      correlationId: Schema.optional(Schema.String),
      causationId: Schema.optional(Schema.String),
      configSnapshot: Schema.optional(Schema.String),
      preconditions: Schema.optional(Schema.Array(TransactionPrecondition)),
    }),
  ),
});
export type TransactRequest = typeof TransactRequest.Type;

export const TransactResponse = Schema.Struct({
  txId: Schema.String,
  asserted: Schema.Array(TripleResponse),
  retracted: Schema.Number,
});
export type TransactResponse = typeof TransactResponse.Type;

export const queryToPattern = (query: QueryRequest) => ({
  ...(query.entityId !== undefined && { entityId: query.entityId }),
  ...(query.attribute !== undefined && { attribute: query.attribute }),
  ...(query.entityType !== undefined && { entityType: query.entityType }),
  ...(query.value !== undefined && { value: query.value }),
});
