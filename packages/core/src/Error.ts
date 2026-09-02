import { Schema } from "effect";

export class DatabaseNotFound extends Schema.TaggedError<DatabaseNotFound>()("DatabaseNotFound", {
  database: Schema.String,
}) {}

export class DatabaseAlreadyExists extends Schema.TaggedError<DatabaseAlreadyExists>()(
  "DatabaseAlreadyExists",
  { database: Schema.String },
) {}

export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {
  message: Schema.String,
}) {}
