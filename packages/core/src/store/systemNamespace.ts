import { Effect } from "effect";

import type { TripleInput, TransactOp } from "../Triple.js";
import { WriteError } from "../errors/index.js";
import type { TransactionMeta, TransactionResult, TriplesService } from "./Triples.js";

const systemWriteAuthorization: unique symbol = Symbol("triplex/SystemWriteAuthorization");

export type InternalTransactionMeta = TransactionMeta & {
  readonly [systemWriteAuthorization]?: true;
};

export const isSystemWriteAuthorized = (meta: TransactionMeta | undefined): boolean =>
  (meta as InternalTransactionMeta | undefined)?.[systemWriteAuthorization] === true;

/** Internal-only entry point for core services that own reserved facts. */
export const transactSystem = (
  triples: TriplesService,
  operations: readonly TransactOp[],
  meta?: TransactionMeta,
): Effect.Effect<
  TransactionResult,
  ReturnType<TriplesService["transact"]> extends Effect.Effect<unknown, infer E> ? E : never
> =>
  triples.transact(operations, {
    ...meta,
    [systemWriteAuthorization]: true,
  } as InternalTransactionMeta);

export const isReservedEntityId = (entityId: string): boolean => entityId.startsWith("_triplex/");

export const isReservedAttribute = (attribute: string): boolean =>
  attribute.startsWith(":triplex/") || attribute.startsWith(":_tx/");

export const isReservedEntityType = (entityType: string | undefined): boolean =>
  entityType === "_Transaction" || entityType?.startsWith("triplex.") === true;

export const reservedWriteReason = (
  input: Pick<TripleInput, "entityId" | "attribute" | "entityType">,
): string | undefined => {
  if (isReservedEntityId(input.entityId)) return `entity ${input.entityId}`;
  if (isReservedAttribute(input.attribute)) return `attribute ${input.attribute}`;
  if (isReservedEntityType(input.entityType)) return `entity type ${input.entityType}`;
  return undefined;
};

export const reservedWriteError = (
  input: Pick<TripleInput, "entityId" | "attribute" | "entityType">,
): WriteError | undefined => {
  const reason = reservedWriteReason(input);
  return reason
    ? new WriteError({
        message: `Write targets reserved Triplex system namespace: ${reason}`,
      })
    : undefined;
};

export const reservedAssertError = (operations: readonly TransactOp[]): WriteError | undefined => {
  for (const operation of operations) {
    if (operation.op !== "assert") continue;
    const error = reservedWriteError(operation);
    if (error) return error;
  }
  return undefined;
};
