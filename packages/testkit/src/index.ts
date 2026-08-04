/**
 * Shared database backend test helpers.
 */

export interface DatabaseBackendFixture {
  readonly name: string;
  readonly capabilities?: readonly string[];
}

export const defineBackendFixture = (fixture: DatabaseBackendFixture): DatabaseBackendFixture =>
  fixture;

export const expectBackendCapability = (
  fixture: DatabaseBackendFixture,
  capability: string,
): boolean => fixture.capabilities?.includes(capability) ?? false;
