/**
 * Validation of ordinary Triple entities against deployed runtime types.
 *
 * A validation is an observation, not a mutable flag on the entity. Results
 * and individual violations are immutable, content-addressed facts. A small
 * head entity identifies the latest result for `(ref, entity type, subject)`;
 * moving that head is atomic, while the old result remains queryable forever.
 */

import { Context, Data, Effect, Layer, Result, Schema, SchemaIssue } from "effect";

import type { DatalogQuery } from "../datalog/types.js";
import type {
  DatalogError,
  ReadError,
  TransactionConflictError,
  WriteError,
} from "../errors/index.js";
import { Triples } from "../store/Triples.js";
import type { TransactionResult } from "../store/Triples.js";
import type { Triple, TransactOp } from "../Triple.js";
import type { TripleValue } from "../Value.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentId from "../content/ContentId.js";
import * as ConfigNode from "./ConfigNode.js";
import * as ConfigStore from "./ConfigStore.js";
import * as TypeExpr from "./TypeExpr.js";
import * as TypeSchema from "./TypeSchema.js";

export const ENTITY_SCHEMA_KIND = "entity-schema";

export const System = {
  prefix: "_triplex/validation/",
  entityType: {
    result: "triplex.validation-result",
    violation: "triplex.validation-violation",
    head: "triplex.validation-head",
    run: "triplex.validation-run",
  },
  attribute: {
    contentId: ":triplex/content-id",
    ref: ":triplex/validation-ref",
    result: ":triplex/validation-result",
    runRef: ":triplex/validation-run-ref",
    runResult: ":triplex/validation-run-result",
    subject: ":triplex/validation-subject",
    entityType: ":triplex/validation-entity-type",
    schema: ":triplex/validation-schema",
    snapshot: ":triplex/validation-snapshot",
    snapshotRoot: ":triplex/validation-snapshot-root",
    valid: ":triplex/validation-valid",
    state: ":triplex/validation-state",
    code: ":triplex/validation-code",
    path: ":triplex/validation-path",
    message: ":triplex/validation-message",
  },
} as const;

const encodePart = (value: string): string => encodeURIComponent(value);

export const entityId = {
  result: (cid: ContentId.ContentId) => `${System.prefix}result/${cid}`,
  violation: (cid: ContentId.ContentId) => `${System.prefix}violation/${cid}`,
  run: (cid: ContentId.ContentId) => `${System.prefix}run/${cid}`,
  head: (ref: string, entityType: string, subject: string) =>
    `${System.prefix}head/${encodePart(ref)}/${encodePart(entityType)}/${encodePart(subject)}`,
};

export interface EntitySchemaDefinition {
  readonly entityType: string;
  readonly type: TypeExpr.TypeExpr;
}

/** Define the runtime shape of entities carrying `entityType`. */
export const define = (
  entityType: string,
  type: TypeExpr.TypeExpr,
): Effect.Effect<
  ConfigNode.ConfigNode,
  ConfigNode.DuplicateChildKeyError | CanonicalJson.CanonicalEncodingError
> =>
  ConfigNode.make({
    kind: ENTITY_SCHEMA_KIND,
    key: entityType,
    attrs: { entityType, type } as unknown as CanonicalJson.CanonicalValue,
  });

export interface ValidationViolation {
  readonly id: ContentId.ContentId;
  readonly resultId: ContentId.ContentId;
  readonly subject: string;
  readonly entityType: string;
  readonly schemaId: ContentId.ContentId;
  readonly snapshotId: string;
  readonly code: "schema";
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly id: ContentId.ContentId;
  readonly subject: string;
  readonly entityType: string;
  readonly schemaId: ContentId.ContentId;
  readonly snapshotId: string;
  readonly snapshotRootCid: ContentId.ContentId;
  readonly valid: boolean;
  readonly state: CanonicalJson.CanonicalValue;
  readonly violations: ReadonlyArray<ValidationViolation>;
}

export interface ValidationRun {
  readonly id: ContentId.ContentId;
  readonly ref: string;
  readonly snapshotId: string;
  readonly snapshotRootCid: ContentId.ContentId;
  readonly results: ReadonlyArray<ValidationResult>;
  /** Undefined when an identical run was already materialized. */
  readonly transaction: TransactionResult | undefined;
}

export interface InvalidEntity {
  readonly subject: string;
  readonly resultEntityId: string;
  readonly schemaId: ContentId.ContentId;
  readonly snapshotEntityId: string;
}

export interface StoredViolation {
  readonly violationEntityId: string;
  readonly resultEntityId: string;
  readonly subject: string;
  readonly path: string;
  readonly message: string;
}

export class UnknownValidationRefError extends Data.TaggedError("UnknownValidationRefError")<{
  readonly ref: string;
  readonly message: string;
}> {}

export class InvalidEntitySchemaError extends Data.TaggedError("InvalidEntitySchemaError")<{
  readonly key: string;
  readonly message: string;
}> {}

export type RevalidateError =
  | ReadError
  | WriteError
  | TransactionConflictError
  | ConfigStore.LoadError
  | UnknownValidationRefError
  | InvalidEntitySchemaError
  | CanonicalJson.CanonicalEncodingError;

export interface EntityValidationService {
  readonly revalidate: (input: {
    readonly ref: string;
  }) => Effect.Effect<ValidationRun, RevalidateError>;
  readonly currentInvalid: (
    ref: string,
  ) => Effect.Effect<ReadonlyArray<InvalidEntity>, ReadError | DatalogError>;
  readonly everInvalid: () => Effect.Effect<ReadonlyArray<string>, ReadError | DatalogError>;
  readonly violations: (input?: {
    readonly subject?: string;
    readonly resultEntityId?: string;
  }) => Effect.Effect<ReadonlyArray<StoredViolation>, ReadError | DatalogError>;
}

export class EntityValidation extends Context.Service<EntityValidation, EntityValidationService>()(
  "triplex/EntityValidation",
) {}

const DefinitionSchema = Schema.Struct({
  entityType: Schema.String,
  type: TypeExpr.TypeExprSchema,
});

const parseDefinition = (
  node: ConfigNode.ConfigNode,
): Effect.Effect<EntitySchemaDefinition, InvalidEntitySchemaError> => {
  const result = Schema.decodeUnknownResult(DefinitionSchema)(node.attrs);
  if (Result.isSuccess(result) && result.success.entityType === node.key) {
    return Effect.succeed(result.success);
  }
  return Effect.fail(
    new InvalidEntitySchemaError({
      key: node.key,
      message: Result.isFailure(result)
        ? `Invalid entity schema ${node.key}: ${result.failure.message}`
        : `Invalid entity schema ${node.key}: key and entityType must match`,
    }),
  );
};

const assertOp = (
  id: string,
  entityType: string,
  attribute: string,
  value: TripleValue,
): TransactOp => ({ op: "assert", entityId: id, entityType, attribute, value });

const nativeValue = (value: TripleValue): CanonicalJson.CanonicalValue => {
  if (value.type === "blob") {
    return {
      hash: value.value,
      mimeType: value.mimeType,
      size: value.size,
      ...(value.filename !== undefined && { filename: value.filename }),
    };
  }
  return value.value as CanonicalJson.CanonicalValue;
};

const materialize = (
  triples: ReadonlyArray<Triple>,
): Effect.Effect<CanonicalJson.CanonicalValue, CanonicalJson.CanonicalEncodingError> =>
  Effect.gen(function* () {
    const byAttribute = new Map<string, CanonicalJson.CanonicalValue[]>();
    for (const triple of triples) {
      const values = byAttribute.get(triple.attribute) ?? [];
      values.push(nativeValue(triple.value));
      byAttribute.set(triple.attribute, values);
    }

    const state: Record<string, CanonicalJson.CanonicalValue> = {};
    for (const [attribute, unsorted] of [...byAttribute].sort(([a], [b]) => a.localeCompare(b))) {
      const encoded = yield* Effect.forEach(unsorted, (value) =>
        CanonicalJson.encode(value).pipe(Effect.map((canonical) => ({ canonical, value }))),
      );
      const values = [...encoded]
        .sort((a, b) => a.canonical.localeCompare(b.canonical))
        .map(({ value }) => value);
      state[attribute] = values.length === 1 ? values[0]! : values;
    }
    return state;
  });

const formatPath = (
  path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined,
): string => {
  if (!path || path.length === 0) return "$";
  return path.reduce<string>((out, part) => {
    const key = typeof part === "object" ? part.key : part;
    if (typeof key === "number") return `${out}[${key}]`;
    const name = String(key);
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
      ? `${out}.${name}`
      : `${out}[${JSON.stringify(name)}]`;
  }, "$");
};

const validationIssues = (
  type: TypeExpr.TypeExpr,
  state: CanonicalJson.CanonicalValue,
): ReadonlyArray<{ readonly path: string; readonly message: string }> => {
  const decoded = Schema.decodeUnknownResult(TypeSchema.compile(type))(state);
  if (Result.isSuccess(decoded)) return [];
  return SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue).issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
};

const grouped = (triples: ReadonlyArray<Triple>): ReadonlyMap<string, ReadonlyArray<Triple>> => {
  const out = new Map<string, Triple[]>();
  for (const triple of triples) {
    const rows = out.get(triple.entityId) ?? [];
    rows.push(triple);
    out.set(triple.entityId, rows);
  }
  return out;
};

const stringValue = (triple: Triple | undefined): string | undefined =>
  triple?.value.type === "string" || triple?.value.type === "ref" ? triple.value.value : undefined;

const rowsAt = (rows: ReadonlyArray<Triple>, attribute: string): ReadonlyArray<Triple> =>
  rows.filter((row) => row.attribute === attribute);

export const currentInvalidQuery = (ref: string): DatalogQuery => ({
  find: ["?subject", "?result", "?schema", "?snapshot"],
  where: [
    [ConfigStore.entityId.ref(ref), ConfigStore.System.attribute.target, "?snapshot"],
    ["?head", System.attribute.ref, ref],
    ["?head", System.attribute.result, "?result"],
    ["?result", System.attribute.snapshot, "?snapshot"],
    ["?result", System.attribute.valid, false],
    ["?result", System.attribute.subject, "?subject"],
    ["?result", System.attribute.schema, "?schema"],
  ],
});

export const everInvalidQuery = (): DatalogQuery => ({
  find: ["?subject"],
  where: [
    ["?result", System.attribute.valid, false],
    ["?result", System.attribute.subject, "?subject"],
  ],
});

export const violationsQuery = (
  input: {
    readonly subject?: string;
    readonly resultEntityId?: string;
  } = {},
): DatalogQuery => {
  const where: DatalogQuery["where"] = [
    ["?violation", System.attribute.result, "?result"],
    ["?violation", System.attribute.subject, "?subject"],
    ["?violation", System.attribute.path, "?path"],
    ["?violation", System.attribute.message, "?message"],
  ];
  return {
    find: ["?violation", "?result", "?subject", "?path", "?message"],
    where: [
      ...where,
      ...(input.resultEntityId === undefined
        ? []
        : [
            [
              "?violation",
              System.attribute.result,
              { type: "ref", value: input.resultEntityId },
            ] as const,
          ]),
      ...(input.subject === undefined
        ? []
        : [
            [
              "?violation",
              System.attribute.subject,
              { type: "ref", value: input.subject },
            ] as const,
          ]),
    ],
  };
};

const invalidFromRows = (
  rows: ReadonlyArray<Readonly<Record<string, string | number | boolean | null>>>,
): ReadonlyArray<InvalidEntity> =>
  rows.flatMap((row) => {
    const subject = row["?subject"];
    const resultEntityId = row["?result"];
    const schemaId = row["?schema"];
    const snapshotEntityId = row["?snapshot"];
    return typeof subject === "string" &&
      typeof resultEntityId === "string" &&
      typeof schemaId === "string" &&
      ContentId.isContentId(schemaId) &&
      typeof snapshotEntityId === "string"
      ? [{ subject, resultEntityId, schemaId, snapshotEntityId }]
      : [];
  });

const makeService = Effect.gen(function* () {
  const triples = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;

  const revalidate: EntityValidationService["revalidate"] = ({ ref }) =>
    Effect.gen(function* () {
      const snapshot = yield* config.resolveRef(ref);
      if (!snapshot) {
        return yield* new UnknownValidationRefError({
          ref,
          message: `Cannot validate entities because config ref ${ref} does not exist`,
        });
      }

      const definitions: EntitySchemaDefinition[] = [];
      const definedEntityTypes = new Set<string>();
      for (const { node } of ConfigNode.walk(snapshot.root)) {
        if (node.kind !== ENTITY_SCHEMA_KIND) continue;
        const definition = yield* parseDefinition(node);
        if (definedEntityTypes.has(definition.entityType)) {
          return yield* new InvalidEntitySchemaError({
            key: definition.entityType,
            message: `Config snapshot ${snapshot.id} contains more than one schema for ${definition.entityType}`,
          });
        }
        definedEntityTypes.add(definition.entityType);
        definitions.push(definition);
      }

      const [resultRows, violationRows, headRows, runRows] = yield* Effect.all([
        triples.match({ entityType: System.entityType.result }),
        triples.match({ entityType: System.entityType.violation }),
        triples.match({ entityType: System.entityType.head }),
        triples.match({ entityType: System.entityType.run }),
      ]);
      const knownResults = new Set<string>(resultRows.map((row) => row.entityId));
      const knownViolations = new Set<string>(violationRows.map((row) => row.entityId));
      const knownRuns = new Set<string>(runRows.map((row) => row.entityId));
      const heads = grouped(headRows);
      const refHeads = new Map<string, ReadonlyArray<Triple>>(
        [...heads].filter(([, rows]) =>
          rowsAt(rows, System.attribute.ref).some((row) => stringValue(row) === ref),
        ),
      );

      const operations: TransactOp[] = [];
      const preconditions: Array<{ readonly _tag: "TripleLive"; readonly id: string }> = [];
      const results: ValidationResult[] = [];
      const activeHeads = new Set<string>();
      const snapshotEntity = ConfigStore.entityId.snapshot(snapshot.id);

      for (const definition of definitions.sort((a, b) =>
        a.entityType.localeCompare(b.entityType),
      )) {
        const schemaId = TypeExpr.id(definition.type);
        const matching = yield* triples.match({ entityType: definition.entityType });
        const subjects = [...new Set(matching.map((row) => row.entityId))].sort();

        for (const subject of subjects) {
          const state = yield* materialize(yield* triples.entity(subject));
          const issues = validationIssues(definition.type, state);
          const resultEncoded = yield* CanonicalJson.encode({
            v: 1,
            subject,
            entityType: definition.entityType,
            schemaId,
            snapshotId: snapshot.id,
            snapshotRootCid: snapshot.rootCid,
            state,
            issues,
          });
          const resultId = ContentId.hash(ContentId.Domain.validationResult, resultEncoded);
          const resultEntity = entityId.result(resultId);
          const violations: ValidationViolation[] = [];

          for (const [index, issue] of issues.entries()) {
            const violationEncoded = yield* CanonicalJson.encode({
              v: 1,
              resultId,
              index,
              code: "schema",
              path: issue.path,
              message: issue.message,
            });
            const id = ContentId.hash(ContentId.Domain.validationViolation, violationEncoded);
            const violation: ValidationViolation = {
              id,
              resultId,
              subject,
              entityType: definition.entityType,
              schemaId,
              snapshotId: snapshot.id,
              code: "schema",
              path: issue.path,
              message: issue.message,
            };
            violations.push(violation);

            const violationEntity = entityId.violation(id);
            if (!knownViolations.has(violationEntity)) {
              operations.push(
                assertOp(violationEntity, System.entityType.violation, System.attribute.contentId, {
                  type: "string",
                  value: id,
                }),
                assertOp(violationEntity, System.entityType.violation, System.attribute.result, {
                  type: "ref",
                  value: resultEntity,
                }),
                assertOp(violationEntity, System.entityType.violation, System.attribute.subject, {
                  type: "ref",
                  value: subject,
                }),
                assertOp(violationEntity, System.entityType.violation, System.attribute.code, {
                  type: "string",
                  value: violation.code,
                }),
                assertOp(violationEntity, System.entityType.violation, System.attribute.path, {
                  type: "string",
                  value: violation.path,
                }),
                assertOp(violationEntity, System.entityType.violation, System.attribute.message, {
                  type: "string",
                  value: violation.message,
                }),
              );
              knownViolations.add(violationEntity);
            }
          }

          const result: ValidationResult = {
            id: resultId,
            subject,
            entityType: definition.entityType,
            schemaId,
            snapshotId: snapshot.id,
            snapshotRootCid: snapshot.rootCid,
            valid: issues.length === 0,
            state,
            violations,
          };
          results.push(result);

          if (!knownResults.has(resultEntity)) {
            operations.push(
              assertOp(resultEntity, System.entityType.result, System.attribute.contentId, {
                type: "string",
                value: resultId,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.subject, {
                type: "ref",
                value: subject,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.entityType, {
                type: "string",
                value: definition.entityType,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.schema, {
                type: "string",
                value: schemaId,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.snapshot, {
                type: "ref",
                value: snapshotEntity,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.snapshotRoot, {
                type: "string",
                value: snapshot.rootCid,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.valid, {
                type: "boolean",
                value: result.valid,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.state, {
                type: "json",
                value: state,
              }),
            );
            knownResults.add(resultEntity);
          }

          const head = entityId.head(ref, definition.entityType, subject);
          activeHeads.add(head);
          const oldTargets = rowsAt(refHeads.get(head) ?? [], System.attribute.result);
          if (!oldTargets.some((row) => stringValue(row) === resultEntity)) {
            preconditions.push(
              ...oldTargets.map((row) => ({ _tag: "TripleLive" as const, id: row.id as string })),
            );
            operations.push(...oldTargets.map((row) => ({ op: "retract", id: row.id }) as const));
            if (!refHeads.has(head)) {
              operations.push(
                assertOp(head, System.entityType.head, System.attribute.ref, {
                  type: "string",
                  value: ref,
                }),
                assertOp(head, System.entityType.head, System.attribute.subject, {
                  type: "ref",
                  value: subject,
                }),
                assertOp(head, System.entityType.head, System.attribute.entityType, {
                  type: "string",
                  value: definition.entityType,
                }),
              );
            }
            operations.push(
              assertOp(head, System.entityType.head, System.attribute.result, {
                type: "ref",
                value: resultEntity,
              }),
            );
          }
        }
      }

      for (const [head, rows] of refHeads) {
        if (activeHeads.has(head)) continue;
        preconditions.push(
          ...rowsAt(rows, System.attribute.result).map((row) => ({
            _tag: "TripleLive" as const,
            id: row.id as string,
          })),
        );
        operations.push(
          ...rowsAt(rows, System.attribute.result).map(
            (row) => ({ op: "retract", id: row.id }) as const,
          ),
        );
      }

      results.sort(
        (a, b) => a.entityType.localeCompare(b.entityType) || a.subject.localeCompare(b.subject),
      );
      const runEncoded = yield* CanonicalJson.encode({
        v: 1,
        ref,
        snapshotRootCid: snapshot.rootCid,
        results: results.map((result) => result.id),
      });
      const runId = ContentId.hash(ContentId.Domain.validationRun, runEncoded);
      const runEntity = entityId.run(runId);
      if (!knownRuns.has(runEntity)) {
        operations.push(
          assertOp(runEntity, System.entityType.run, System.attribute.contentId, {
            type: "string",
            value: runId,
          }),
          assertOp(runEntity, System.entityType.run, System.attribute.runRef, {
            type: "string",
            value: ref,
          }),
          assertOp(runEntity, System.entityType.run, System.attribute.snapshot, {
            type: "ref",
            value: snapshotEntity,
          }),
          ...results.map((result) =>
            assertOp(runEntity, System.entityType.run, System.attribute.runResult, {
              type: "ref",
              value: entityId.result(result.id),
            }),
          ),
        );
      }

      const transaction =
        operations.length === 0
          ? undefined
          : yield* triples.transact(operations, {
              actor: "triplex/entity-validation",
              configSnapshot: snapshot.id,
              preconditions,
            });
      return {
        id: runId,
        ref,
        snapshotId: snapshot.id,
        snapshotRootCid: snapshot.rootCid,
        results,
        transaction,
      };
    });

  const service: EntityValidationService = {
    revalidate,
    currentInvalid: (ref: string) =>
      triples
        .query(currentInvalidQuery(ref))
        .pipe(
          Effect.map((response) =>
            [...invalidFromRows(response.results)].sort(
              (a, b) =>
                a.subject.localeCompare(b.subject) ||
                a.resultEntityId.localeCompare(b.resultEntityId),
            ),
          ),
        ),
    everInvalid: () =>
      triples.query(everInvalidQuery()).pipe(
        Effect.map((response) =>
          response.results
            .map((row) => row["?subject"])
            .filter((subject): subject is string => typeof subject === "string")
            .sort(),
        ),
      ),
    violations: (input?: { readonly subject?: string; readonly resultEntityId?: string }) =>
      triples.query(violationsQuery(input)).pipe(
        Effect.map((response) =>
          response.results
            .flatMap((row) => {
              const violationEntityId = row["?violation"];
              const resultEntityId = row["?result"];
              const subject = row["?subject"];
              const path = row["?path"];
              const message = row["?message"];
              return typeof violationEntityId === "string" &&
                typeof resultEntityId === "string" &&
                typeof subject === "string" &&
                typeof path === "string" &&
                typeof message === "string"
                ? [{ violationEntityId, resultEntityId, subject, path, message }]
                : [];
            })
            .sort(
              (a, b) =>
                a.subject.localeCompare(b.subject) ||
                a.path.localeCompare(b.path) ||
                a.violationEntityId.localeCompare(b.violationEntityId),
            ),
        ),
      ),
  };
  return service;
});

export const layer: Layer.Layer<EntityValidation, never, Triples | ConfigStore.ConfigStore> =
  Layer.effect(EntityValidation, makeService);
