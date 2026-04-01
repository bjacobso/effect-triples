import { Schema } from "effect";

export const TripleId = Schema.String.pipe(
  Schema.pattern(/^[0-9A-Z]{26}$/),
  Schema.brand("TripleId"),
);
export type TripleId = typeof TripleId.Type;

export const EntityId = Schema.String.pipe(Schema.minLength(1), Schema.brand("EntityId"));
export type EntityId = typeof EntityId.Type;

export const Attribute = Schema.String.pipe(
  Schema.pattern(/^:[a-zA-Z_][a-zA-Z0-9_-]*\/[a-zA-Z][a-zA-Z0-9_-]*$/),
  Schema.brand("Attribute"),
  Schema.annotations({
    identifier: "Attribute",
    description: "Namespaced attribute name in format :namespace/attribute",
  }),
);
export type Attribute = typeof Attribute.Type;

export const DatabaseName = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/),
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.brand("DatabaseName"),
);
export type DatabaseName = typeof DatabaseName.Type;

export const TransactionId = Schema.String.pipe(
  Schema.pattern(/^_tx\/[0-9A-Z]{26}$/),
  Schema.brand("TransactionId"),
);
export type TransactionId = typeof TransactionId.Type;

export type PaginationCursorData = {
  readonly [variable: string]: string | number | boolean | null;
};

const PaginationCursorDataSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean, Schema.Null),
});

export const PaginationCursor = Schema.transform(Schema.String, PaginationCursorDataSchema, {
  strict: true,
  decode: (encoded) => JSON.parse(atob(encoded)) as PaginationCursorData,
  encode: (data) => btoa(JSON.stringify(data)),
}).pipe(Schema.brand("PaginationCursor"));
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
  tripleId: (s: string) => Schema.decode(TripleId)(s),
  entityId: (s: string) => Schema.decode(EntityId)(s),
  attribute: (s: string) => Schema.decode(Attribute)(s),
  databaseName: (s: string) => Schema.decode(DatabaseName)(s),
  transactionId: (s: string) => Schema.decode(TransactionId)(s),
  paginationCursor: (s: string) => Schema.decode(PaginationCursor)(s),
};

export const unsafe = {
  tripleId: (s: string) => Schema.decodeSync(TripleId)(s),
  entityId: (s: string) => Schema.decodeSync(EntityId)(s),
  attribute: (s: string) => Schema.decodeSync(Attribute)(s),
  databaseName: (s: string) => Schema.decodeSync(DatabaseName)(s),
  transactionId: (s: string) => Schema.decodeSync(TransactionId)(s),
  paginationCursor: (s: string) => Schema.decodeSync(PaginationCursor)(s),
};
