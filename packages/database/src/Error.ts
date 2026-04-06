import { HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

export class DatabaseNotFound extends Schema.TaggedError<DatabaseNotFound>()(
  "DatabaseNotFound",
  { database: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class DatabaseAlreadyExists extends Schema.TaggedError<DatabaseAlreadyExists>()(
  "DatabaseAlreadyExists",
  { database: Schema.String },
  HttpApiSchema.annotations({ status: 409 }),
) {}

export class TripleNotFound extends Schema.TaggedError<TripleNotFound>()(
  "TripleNotFound",
  { id: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class DatalogQueryError extends Schema.TaggedError<DatalogQueryError>()(
  "DatalogQueryError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class AuthorizationDenied extends Schema.TaggedError<AuthorizationDenied>()(
  "AuthorizationDenied",
  {
    code: Schema.Literal("AUTHORIZATION_DENIED"),
    decisionId: Schema.String,
    reason: Schema.String,
    deniedFields: Schema.optional(Schema.Array(Schema.String)),
    deniedAttributes: Schema.optional(Schema.Array(Schema.String)),
  },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class AccessDenied extends Schema.TaggedError<AccessDenied>()(
  "AccessDenied",
  {
    message: Schema.String,
    database: Schema.optional(Schema.String),
  },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}
