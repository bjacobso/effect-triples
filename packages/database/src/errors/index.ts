/**
 * Database error types.
 *
 * All error types used by the database package live here.
 * Core errors that were previously in @open-ontology/core/errors
 * are now owned by the database package.
 */

import { Data } from "effect";

// Write operation errors
export class WriteError extends Data.TaggedError("WriteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DuplicateTripleError extends Data.TaggedError("DuplicateTripleError")<{
  readonly entityId: string;
  readonly attribute: string;
  readonly message: string;
}> {}

export class InvalidTripleError extends Data.TaggedError("InvalidTripleError")<{
  readonly field: string;
  readonly value: unknown;
  readonly message: string;
}> {}

export class TransactionError extends Data.TaggedError("TransactionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Read operation errors
export class ReadError extends Data.TaggedError("ReadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class EntityNotFoundError extends Data.TaggedError("EntityNotFoundError")<{
  readonly entityId: string;
}> {}

export class TripleNotFoundError extends Data.TaggedError("TripleNotFoundError")<{
  readonly tripleId: string;
}> {}

// Query errors
export class QueryError extends Data.TaggedError("QueryError")<{
  readonly message: string;
  readonly sql?: string;
  readonly cause?: unknown;
}> {}

export class InvalidPatternError extends Data.TaggedError("InvalidPatternError")<{
  readonly pattern: unknown;
  readonly message: string;
}> {}

// Parse errors (Datalog)
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly source?: string;
}> {}

export class UnexpectedTokenError extends Data.TaggedError("UnexpectedTokenError")<{
  readonly expected: string;
  readonly found: string;
  readonly line: number;
  readonly column: number;
}> {}

export class UndefinedVariableError extends Data.TaggedError("UndefinedVariableError")<{
  readonly variable: string;
  readonly line: number;
}> {}

// Schema/validation errors
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly field: string;
  readonly message: string;
  readonly value?: unknown;
}> {}

// Datalog query errors
export class DatalogError extends Data.TaggedError("DatalogError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class UnboundVariableError extends Data.TaggedError("UnboundVariableError")<{
  readonly variable: string;
  readonly clause: unknown;
}> {}

export class InvalidPredicateError extends Data.TaggedError("InvalidPredicateError")<{
  readonly predicate: unknown;
  readonly message: string;
}> {}

export class DatalogValidationError extends Data.TaggedError("DatalogValidationError")<{
  readonly message: string;
  readonly query: unknown;
  readonly cause?: unknown;
}> {}

// SPARQL query errors
export class SparqlError extends Data.TaggedError("SparqlError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SparqlValidationError extends Data.TaggedError("SparqlValidationError")<{
  readonly message: string;
  readonly query: unknown;
  readonly cause?: unknown;
}> {}

// Migration errors
export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly version: number;
  readonly name: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Re-export HTTP-annotated errors from Error.ts
export {
  DatabaseNotFound,
  DatabaseAlreadyExists,
  TripleNotFound,
  DatalogQueryError,
  InternalError,
} from "../Error.js";

// Error unions for convenience
export type WriteErrorUnion =
  | WriteError
  | DuplicateTripleError
  | InvalidTripleError
  | TransactionError;

export type ReadErrorUnion = ReadError | EntityNotFoundError | TripleNotFoundError;

export type QueryErrorUnion = QueryError | InvalidPatternError;

export type ParseErrorUnion = ParseError | UnexpectedTokenError | UndefinedVariableError;

export type DatalogErrorUnion =
  | DatalogError
  | UnboundVariableError
  | InvalidPredicateError
  | DatalogValidationError;

export type TripleStoreError =
  | WriteErrorUnion
  | ReadErrorUnion
  | QueryErrorUnion
  | ParseErrorUnion
  | DatalogErrorUnion
  | ValidationError
  | MigrationError;
