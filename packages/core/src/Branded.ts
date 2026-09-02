import { Schema } from "effect";

export const TripleId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9A-Z]{26}$/)),
  Schema.brand("TripleId"),
);
export type TripleId = typeof TripleId.Type;

const EntityIdSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("EntityId"),
);
export const EntityId = Object.assign(EntityIdSchema, {
  decode: (s: string) => Schema.decodeEffect(EntityIdSchema)(s),
  make: (s: string): EntityId => Schema.decodeSync(EntityIdSchema)(s),
});
export type EntityId = typeof EntityIdSchema.Type;

export const Attribute = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^:[a-zA-Z_][a-zA-Z0-9_-]*\/[a-zA-Z][a-zA-Z0-9_-]*$/)),
  Schema.brand("Attribute"),
  Schema.annotate({
    identifier: "Attribute",
    description: "Namespaced attribute name in format :namespace/attribute",
  }),
);
export type Attribute = typeof Attribute.Type;

const DatabaseIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/)),
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.brand("DatabaseId"),
);
export const DatabaseId = Object.assign(DatabaseIdSchema, {
  decode: (s: string) => Schema.decodeEffect(DatabaseIdSchema)(s),
  make: (s: string): DatabaseId => Schema.decodeSync(DatabaseIdSchema)(s),
});
export type DatabaseId = typeof DatabaseIdSchema.Type;

/** @deprecated Use `DatabaseId`; retained as the pre-1.0 schema alias. */
export const DatabaseName = DatabaseId;
export type DatabaseName = DatabaseId;

export const TransactionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^_tx\/[0-9A-Z]{26}$/)),
  Schema.brand("TransactionId"),
);
export type TransactionId = typeof TransactionId.Type;

export const decode = {
  tripleId: (s: string) => Schema.decodeEffect(TripleId)(s),
  entityId: EntityId.decode,
  attribute: (s: string) => Schema.decodeEffect(Attribute)(s),
  databaseName: (s: string) => Schema.decodeEffect(DatabaseName)(s),
  databaseId: DatabaseId.decode,
  transactionId: (s: string) => Schema.decodeEffect(TransactionId)(s),
};

export const unsafe = {
  tripleId: (s: string) => Schema.decodeSync(TripleId)(s),
  entityId: EntityId.make,
  attribute: (s: string) => Schema.decodeSync(Attribute)(s),
  databaseName: (s: string) => Schema.decodeSync(DatabaseName)(s),
  databaseId: DatabaseId.make,
  transactionId: (s: string) => Schema.decodeSync(TransactionId)(s),
};
