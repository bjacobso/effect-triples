/** Ergonomic entity-type declarations compiled to content-addressed config nodes. */

import { Effect } from "effect";

import * as CanonicalJson from "../content/CanonicalJson.js";
import * as Attribute from "./Attribute.js";
import * as ConfigNode from "./ConfigNode.js";
import { ENTITY_SCHEMA_KIND } from "./EntityValidation.js";
import * as TypeExpr from "./TypeExpr.js";

const ENTITY_TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/;
const RESERVED_PROPERTIES = new Set(["entityType", "schema", "node", "nodes", "attributes"]);

type Uses = Readonly<Record<string, Attribute.Use<Attribute.AnyDefinition>>>;

export interface AttributeHandle<D extends Attribute.AnyDefinition> {
  readonly key: D["key"];
  readonly type: TypeExpr.TypeExpr;
  readonly required: boolean;
  readonly cardinality: "one" | "many";
  readonly definition: D;
  readonly assertion: (
    value: Attribute.ValueOf<D>,
    options?: Attribute.AssertionOptions,
  ) => Attribute.Assertion<D["key"]>;
}

type Handles<A extends Uses> = {
  readonly [P in keyof A]: AttributeHandle<A[P]["attribute"]>;
};

export type EntityType<N extends string, A extends Uses> = {
  readonly entityType: N;
  readonly schema: TypeExpr.Struct;
  readonly attributes: Handles<A>;
  /** The entity-schema node that references each global attribute definition. */
  readonly node: Effect.Effect<
    ConfigNode.ConfigNode,
    | ConfigNode.DuplicateChildKeyError
    | CanonicalJson.CanonicalEncodingError
    | import("effect").Schema.SchemaError
  >;
  /** Attribute definition nodes followed by the entity-schema node. */
  readonly nodes: Effect.Effect<
    ReadonlyArray<ConfigNode.ConfigNode>,
    | ConfigNode.DuplicateChildKeyError
    | CanonicalJson.CanonicalEncodingError
    | import("effect").Schema.SchemaError
  >;
} & Handles<A>;

const DefinitionType = TypeExpr.struct({
  entityType: TypeExpr.required(TypeExpr.text),
  type: TypeExpr.required(TypeExpr.any),
  attributes: TypeExpr.required(TypeExpr.any),
});

export const make = <const N extends string, const A extends Uses>(
  name: N,
  definition: { readonly attributes: A },
): EntityType<N, A> => {
  if (!ENTITY_TYPE_NAME.test(name)) {
    throw new TypeError(`Entity type identity must be PascalCase; received ${name}`);
  }

  const fields: Record<string, TypeExpr.StructField> = {};
  const handles: Record<string, AttributeHandle<Attribute.AnyDefinition>> = {};
  const usage: Record<string, CanonicalJson.CanonicalValue> = {};
  const definitions = new Map<string, Attribute.AnyDefinition>();

  for (const [property, attributeUse] of Object.entries(definition.attributes)) {
    if (RESERVED_PROPERTIES.has(property)) {
      throw new TypeError(`Entity attribute alias ${property} is reserved by the EntityType API`);
    }
    const attribute = attributeUse.attribute;
    if (definitions.has(attribute.key)) {
      throw new TypeError(
        `Entity type ${name} uses ${attribute.key} more than once; one global attribute may have only one usage in an entity type`,
      );
    }
    const valueType =
      attributeUse.cardinality === "many" ? TypeExpr.list(attribute.type) : attribute.type;
    fields[attribute.key] = attributeUse.required
      ? TypeExpr.required(valueType)
      : TypeExpr.optional(valueType);
    usage[property] = {
      attribute: attribute.key,
      required: attributeUse.required,
      cardinality: attributeUse.cardinality,
    };
    definitions.set(attribute.key, attribute);
    handles[property] = {
      key: attribute.key,
      type: attribute.type,
      required: attributeUse.required,
      cardinality: attributeUse.cardinality,
      definition: attribute,
      assertion: (value, options) => Attribute.assertion(attribute, value, options),
    };
  }

  const schema = TypeExpr.struct(fields);
  const node = ConfigNode.makeTyped({
    kind: ENTITY_SCHEMA_KIND,
    key: name,
    type: DefinitionType,
    attrs: { entityType: name, type: schema, attributes: usage },
    refs: [...definitions.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((attribute) => ({ rel: "uses-attribute", kind: Attribute.KIND, key: attribute.key })),
  });
  const nodes = Effect.all([
    ...[...definitions.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((attribute) => attribute.node),
    node,
  ]);
  const entity = {
    entityType: name,
    schema,
    attributes: handles as Handles<A>,
    node,
    nodes,
    ...handles,
  };
  return entity as EntityType<N, A>;
};
