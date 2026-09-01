import { Schema, SchemaTransformation } from "effect";

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

export const DatabaseName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/)),
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.brand("DatabaseName"),
);
export type DatabaseName = typeof DatabaseName.Type;

export const TransactionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^_tx\/[0-9A-Z]{26}$/)),
  Schema.brand("TransactionId"),
);
export type TransactionId = typeof TransactionId.Type;

export type PaginationCursorData = {
  readonly [variable: string]: string | number | boolean | null;
};

const PaginationCursorDataSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
);

export const PaginationCursor = Schema.String.pipe(
  Schema.decodeTo(
    PaginationCursorDataSchema,
    SchemaTransformation.transform({
      decode: (encoded) => JSON.parse(atob(encoded)) as PaginationCursorData,
      encode: (data) => btoa(JSON.stringify(data)),
    }),
  ),
  Schema.brand("PaginationCursor"),
);
export type PaginationCursor = typeof PaginationCursor.Type;

export const createPaginationCursor = (
  row: Record<string, unknown>,
  orderBy: readonly { variable: string }[],
): string => {
  const data: Record<string, string | number | boolean | null> = {};
  for (const { variable } of orderBy) {
    data[variable] = row[variable] as string | number | boolean | null;
  }
  return btoa(JSON.stringify(data));
};

export const decode = {
  tripleId: (s: string) => Schema.decodeEffect(TripleId)(s),
  entityId: EntityId.decode,
  attribute: (s: string) => Schema.decodeEffect(Attribute)(s),
  databaseName: (s: string) => Schema.decodeEffect(DatabaseName)(s),
  transactionId: (s: string) => Schema.decodeEffect(TransactionId)(s),
  paginationCursor: (s: string) => Schema.decodeEffect(PaginationCursor)(s),
};

export const unsafe = {
  tripleId: (s: string) => Schema.decodeSync(TripleId)(s),
  entityId: EntityId.make,
  attribute: (s: string) => Schema.decodeSync(Attribute)(s),
  databaseName: (s: string) => Schema.decodeSync(DatabaseName)(s),
  transactionId: (s: string) => Schema.decodeSync(TransactionId)(s),
  paginationCursor: (s: string) => Schema.decodeSync(PaginationCursor)(s),
};
