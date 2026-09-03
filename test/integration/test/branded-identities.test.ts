import { describe, expect, it } from "vitest";

import { EntityId, type TripleInput, ref, string } from "@bjacobso/triplex";

describe("branded public identities", () => {
  it("requires decoded entity ids for assertions and references", () => {
    const person = EntityId.make("person:alice");
    const employer = EntityId.make("company:acme");
    const input: TripleInput = {
      entityId: person,
      attribute: ":person/employer",
      value: ref(employer),
    };

    expect(input.entityId).toBe("person:alice");

    const unbrandedEntity: TripleInput = {
      // @ts-expect-error Public writes do not accept an unvalidated entity id.
      entityId: "person:bob",
      attribute: ":person/name",
      value: string("Bob"),
    };
    expect(unbrandedEntity.entityId).toBe("person:bob");

    // @ts-expect-error Reference values also require a branded target id.
    ref("company:other");
  });
});
