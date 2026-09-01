import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { Triples } from "../../src/store/Triples.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as EntityType from "../../src/config/EntityType.js";
import * as EntityValidation from "../../src/config/EntityValidation.js";

const EmployerName = Attribute.text(":employer/name");
const WorkerName = Attribute.text(":worker/name");

const Employer = EntityType.make("Employer", {
  attributes: {
    name: Attribute.use(EmployerName, { required: true }),
  },
});

const EmployerSummary = EntityType.make("EmployerSummary", {
  attributes: {
    name: Attribute.use(EmployerName, { required: false }),
  },
});

const Worker = EntityType.make("Worker", {
  attributes: {
    name: Attribute.use(WorkerName, { required: true }),
  },
});

const EmploymentEmployer = Attribute.ref(":employment/employer", Employer);
const EmploymentWorker = Attribute.ref(":employment/worker", Worker);

const Employment = EntityType.make("Employment", {
  attributes: {
    employer: Attribute.use(EmploymentEmployer, { required: true }),
    worker: Attribute.use(EmploymentWorker, { required: true }),
  },
});

describe("ontology DSL", () => {
  it.effect("separates global attribute identity from entity-local usage", () =>
    Effect.gen(function* () {
      expect(Employer.name.key).toBe(":employer/name");
      expect(Employer.name.required).toBe(true);
      expect(EmployerSummary.name.key).toBe(Employer.name.key);
      expect(EmployerSummary.name.required).toBe(false);
      expect(Employer.schema.fields[":employer/name"]?.optional).toBe(false);
      expect(EmployerSummary.schema.fields[":employer/name"]?.optional).toBe(true);

      const employerNameNode = yield* EmployerName.node;
      const sharedNameNode = yield* EmployerSummary.name.definition.node;
      expect(sharedNameNode.cid).toBe(employerNameNode.cid);

      const employerNode = yield* Employer.node;
      expect(employerNode.refs).toEqual([
        {
          rel: "uses-attribute",
          kind: Attribute.KIND,
          key: ":employer/name",
        },
      ]);
    }),
  );

  it("builds typed scalar and reference assertions", () => {
    expect(Employer.name.assertion("Acme", { validFrom: 1_700_000_000_000 })).toEqual({
      attribute: ":employer/name",
      value: { type: "string", value: "Acme" },
      validFrom: 1_700_000_000_000,
    });
    expect(Employment.employer.assertion("employer:acme")).toEqual({
      attribute: ":employment/employer",
      value: { type: "ref", value: "employer:acme" },
    });
    expect(Employment.employer.type).toEqual({
      _tag: "Ref",
      v: 1,
      kind: "Employer",
    });
  });

  it.effect("makes reference targets explicit in the configuration graph", () =>
    Effect.gen(function* () {
      const node = yield* EmploymentEmployer.node;
      expect(node.refs).toEqual([
        {
          rel: "references-entity-type",
          kind: "entity-schema",
          key: "Employer",
        },
      ]);
    }),
  );

  it.effect("commits the typed graph and validates ordinary facts from it", () => {
    const ConfigLayer = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
    const AppLayer = EntityValidation.layer.pipe(Layer.provideMerge(ConfigLayer));
    return Effect.gen(function* () {
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      const validation = yield* EntityValidation.EntityValidation;

      yield* config.commit({
        label: "ontology v1",
        objects: yield* Employer.nodes,
        ref: "live",
      });
      yield* triples.transact([
        {
          op: "assert",
          entityId: "employer:acme",
          entityType: Employer.entityType,
          attribute: Employer.name.key,
          value: Employer.name.assertion("Acme").value,
        },
      ]);

      const run = yield* validation.revalidate({ ref: "live" });
      expect(run.results).toEqual([
        expect.objectContaining({
          entityType: "Employer",
          subject: "employer:acme",
          valid: true,
          state: { ":employer/name": "Acme" },
        }),
      ]);
    }).pipe(Effect.provide(AppLayer));
  });

  it("rejects identities outside the public naming conventions", () => {
    expect(() => Attribute.text(":Employer/name")).toThrow(/lowercase namespaced keyword/);
    expect(() => EntityType.make("employer", { attributes: {} })).toThrow(/PascalCase/);
  });
});
