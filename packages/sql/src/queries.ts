import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type {
  TripleRow,
  Triple,
  TripleId,
  EntityId,
  Attribute,
  TripleValue,
  ValueType,
} from "@bjacobso/triplex";
import { ReadError, WriteError } from "@bjacobso/triplex";

// Convert TripleValue to database columns
export const packValue = (
  value: TripleValue,
): {
  value_type: ValueType;
  value_string: string | null;
  value_number: number | null;
  value_boolean: number | null;
  value_datetime: number | null;
  value_json: string | null;
} => {
  const base = {
    value_string: null as string | null,
    value_number: null as number | null,
    value_boolean: null as number | null,
    value_datetime: null as number | null,
    value_json: null as string | null,
  };

  switch (value.type) {
    case "string":
      return { ...base, value_type: "string", value_string: value.value };
    case "number":
      return { ...base, value_type: "number", value_number: value.value };
    case "boolean":
      return { ...base, value_type: "boolean", value_boolean: value.value ? 1 : 0 };
    case "datetime":
      return { ...base, value_type: "datetime", value_datetime: value.value };
    case "ref":
      return { ...base, value_type: "ref", value_string: value.value };
    case "json":
      return { ...base, value_type: "json", value_json: JSON.stringify(value.value) };
    case "blob":
      return {
        ...base,
        value_type: "blob",
        value_string: value.value, // hash
        value_json: JSON.stringify({
          mimeType: value.mimeType,
          size: value.size,
          ...(value.filename && { filename: value.filename }),
        }),
      };
  }
};

// Extract TripleValue from database row
export const unpackValue = (row: TripleRow): TripleValue => {
  switch (row.value_type) {
    case "string":
      return { type: "string", value: row.value_string ?? "" };
    case "number":
      return { type: "number", value: row.value_number ?? 0 };
    case "boolean":
      return { type: "boolean", value: row.value_boolean === 1 };
    case "datetime":
      return { type: "datetime", value: row.value_datetime ?? 0 };
    case "ref":
      return { type: "ref", value: row.value_string ?? "" };
    case "json":
      return { type: "json", value: row.value_json ? JSON.parse(row.value_json) : null };
    case "blob": {
      const meta = row.value_json ? JSON.parse(row.value_json) : {};
      return {
        type: "blob",
        value: row.value_string ?? "",
        mimeType: meta.mimeType ?? "application/octet-stream",
        size: meta.size ?? 0,
        ...(meta.filename && { filename: meta.filename }),
      };
    }
    default:
      return { type: "string", value: "" };
  }
};

// Convert database row to Triple
export const rowToTriple = (row: TripleRow): Triple => ({
  id: row.id as TripleId,
  entityId: row.entity_id as EntityId,
  attribute: row.attribute as Attribute,
  value: unpackValue(row),
  createdAt: row.created_at,
  createdBy: row.created_by ? Option.some(row.created_by) : Option.none(),
  retractedAt: row.retracted_at ? Option.some(row.retracted_at) : Option.none(),
  entityType: row.entity_type ? Option.some(row.entity_type) : Option.none(),
  schemaVersion: row.schema_version ? Option.some(row.schema_version) : Option.none(),
  txId: row.tx_id ? Option.some(row.tx_id) : Option.none(),
  retractTxId: row.retract_tx_id ? Option.some(row.retract_tx_id) : Option.none(),
});

// Insert a triple
export const insertTriple = (
  id: string,
  entityId: string,
  attribute: string,
  value: TripleValue,
  createdAt: number,
  createdBy: string | null,
  entityType: string | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const packed = packValue(value);

    yield* Effect.tryPromise({
      try: () =>
        Effect.runPromise(
          sql`
            INSERT INTO triples (
              id, entity_id, attribute, value_type,
              value_string, value_number, value_boolean, value_datetime, value_json,
              created_at, created_by, entity_type, schema_version
            ) VALUES (
              ${id}, ${entityId}, ${attribute}, ${packed.value_type},
              ${packed.value_string}, ${packed.value_number}, ${packed.value_boolean},
              ${packed.value_datetime}, ${packed.value_json},
              ${createdAt}, ${createdBy}, ${entityType}, ${1}
            )
          `,
        ),
      catch: (error) =>
        new WriteError({
          message: `Failed to insert triple: ${String(error)}`,
          cause: error,
        }),
    });
  });

// Retract a triple (soft delete)
export const retractTriple = (tripleId: string, retractedAt: number, txId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* Effect.tryPromise({
      try: () =>
        Effect.runPromise(
          sql`
            UPDATE triples
            SET retracted_at = ${retractedAt}, retract_tx_id = ${txId ?? null}
            WHERE id = ${tripleId} AND retracted_at IS NULL
          `,
        ),
      catch: (error) =>
        new WriteError({
          message: `Failed to retract triple: ${String(error)}`,
          cause: error,
        }),
    });
  });

// Get a single triple by ID
export const getTripleById = (tripleId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* Effect.tryPromise({
      try: () =>
        Effect.runPromise(
          sql<TripleRow>`
            SELECT * FROM triples
            WHERE id = ${tripleId} AND retracted_at IS NULL
          `,
        ),
      catch: (error) =>
        new ReadError({
          message: `Failed to get triple: ${String(error)}`,
          cause: error,
        }),
    });

    return rows.length > 0 ? rowToTriple(rows[0]!) : null;
  });

// Get all active triples for an entity
export const getEntityTriples = (entityId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* Effect.tryPromise({
      try: () =>
        Effect.runPromise(
          sql<TripleRow>`
            SELECT * FROM triples
            WHERE entity_id = ${entityId} AND retracted_at IS NULL
          `,
        ),
      catch: (error) =>
        new ReadError({
          message: `Failed to get entity triples: ${String(error)}`,
          cause: error,
        }),
    });

    return rows.map(rowToTriple);
  });

// Query triples by attribute
export const queryByAttribute = (attribute: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* Effect.tryPromise({
      try: () =>
        Effect.runPromise(
          sql<TripleRow>`
            SELECT * FROM triples
            WHERE attribute = ${attribute} AND retracted_at IS NULL
          `,
        ),
      catch: (error) =>
        new ReadError({
          message: `Failed to query by attribute: ${String(error)}`,
          cause: error,
        }),
    });

    return rows.map(rowToTriple);
  });

// Query triples by entity type
export const queryByEntityType = (entityType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* Effect.tryPromise({
      try: () =>
        Effect.runPromise(
          sql<TripleRow>`
            SELECT * FROM triples
            WHERE entity_type = ${entityType} AND retracted_at IS NULL
          `,
        ),
      catch: (error) =>
        new ReadError({
          message: `Failed to query by entity type: ${String(error)}`,
          cause: error,
        }),
    });

    return rows.map(rowToTriple);
  });

// Time-travel: get entity state as of a specific time
export const getEntityAsOf = (entityId: string, asOf: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* Effect.tryPromise({
      try: () =>
        Effect.runPromise(
          sql<TripleRow>`
            SELECT * FROM triples
            WHERE entity_id = ${entityId}
              AND created_at <= ${asOf}
              AND (retracted_at IS NULL OR retracted_at > ${asOf})
          `,
        ),
      catch: (error) =>
        new ReadError({
          message: `Failed to get entity as of: ${String(error)}`,
          cause: error,
        }),
    });

    return rows.map(rowToTriple);
  });

// Get full history of an entity (including retracted triples)
export const getEntityHistory = (entityId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* Effect.tryPromise({
      try: () =>
        Effect.runPromise(
          sql<TripleRow>`
            SELECT * FROM triples
            WHERE entity_id = ${entityId}
            ORDER BY created_at ASC
          `,
        ),
      catch: (error) =>
        new ReadError({
          message: `Failed to get entity history: ${String(error)}`,
          cause: error,
        }),
    });

    return rows.map(rowToTriple);
  });
