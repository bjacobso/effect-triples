/**
 * When is an instance written under one schema still valid under another?
 *
 * A stored config node is not bound to the single schema that wrote it. If v2
 * adds an optional field, every instance that satisfied v1 still satisfies v2,
 * and treating that deploy as "everything changed" is noise. What we want to
 * record is not one schema per instance but the *set* of schemas an instance is
 * known to satisfy, growing as new shapes are deployed and proven compatible.
 *
 * This module supplies the cheap half of that. `subsumes(from, to)` decides,
 * structurally and once per schema pair, whether *every* instance of `from` is
 * accepted by `to`. When it answers `Widens`, an entire generation of stored
 * objects is revalidated for free - no instance is touched. That is the
 * difference between an O(schemas^2) check and an O(instances x schemas) one,
 * and at the scale of an account's config only the first is affordable.
 *
 * The check is **sound but incomplete**, deliberately and in that order. A
 * `Widens` verdict is a proof and may be relied on. `Unknown` means this module
 * could not decide and the caller must fall back to validating actual instances
 * (`ConfigStore.recheck`); it never means "probably fine". Full JSON Schema
 * subsumption is not something to be clever about, so anything outside the
 * fragment Effect emits for config projections - objects with `properties` /
 * `required` / `additionalProperties`, `enum`, primitive `type`, arrays, and
 * `$ref` into `$defs` - returns `Unknown` rather than a guess.
 *
 * `Narrows` is the interesting verdict in practice. It says the new shape
 * rejects instances the old one accepted, which is precisely the deploy that
 * silently breaks existing configuration, and it is knowable before the code
 * ships rather than after a customer's form fails to load.
 */

import { Data, Effect } from "effect";

import * as CanonicalJson from "./CanonicalJson";
import * as SchemaId from "./SchemaId";

export type Verdict = Data.TaggedEnum<{
  /** Byte-identical shapes. */
  Identical: {};
  /** Proven: every instance of `from` is accepted by `to`. */
  Widens: { readonly reasons: ReadonlyArray<string> };
  /** Proven: `to` rejects instances `from` accepted. */
  Narrows: { readonly reasons: ReadonlyArray<string> };
  /** Undecidable here. Validate real instances instead. */
  Unknown: { readonly reasons: ReadonlyArray<string> };
}>;

export const Verdict = Data.taggedEnum<Verdict>();

/** True when the verdict is a proof that existing instances stay valid. */
export const isCompatible = (verdict: Verdict): boolean =>
  verdict._tag === "Identical" || verdict._tag === "Widens";

type Doc = Record<string, unknown>;

const isDoc = (value: unknown): value is Doc =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const REF_LIMIT = 32;

/** Resolve `#/$defs/Name` against the document root. */
const deref = (node: unknown, root: Doc, depth = 0): unknown => {
  if (!isDoc(node) || typeof node.$ref !== "string") return node;
  if (depth >= REF_LIMIT) return undefined;

  const path = node.$ref.replace(/^#\//, "").split("/");
  let current: unknown = root;
  for (const segment of path) {
    if (!isDoc(current)) return undefined;
    current = current[segment];
  }
  return deref(current, root, depth + 1);
};

const stringsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; // prettier-ignore

const encodedSet = (value: unknown): ReadonlySet<string> =>
  new Set(
    Array.isArray(value)
      ? value.map((item) =>
          CanonicalJson.encodeOrThrow(item as CanonicalJson.CanonicalValue)
        )
      : []
  );

/** Worst verdict wins; `Narrows` is absorbing. */
const worst = (verdicts: ReadonlyArray<Verdict>): Verdict => {
  const reasons = verdicts.flatMap((v) =>
    v._tag === "Identical" ? [] : v.reasons
  );
  if (verdicts.some((v) => v._tag === "Narrows")) {
    return Verdict.Narrows({
      reasons: verdicts.flatMap((v) => (v._tag === "Narrows" ? v.reasons : [])),
    });
  }
  if (verdicts.some((v) => v._tag === "Unknown")) {
    return Verdict.Unknown({ reasons });
  }
  if (verdicts.every((v) => v._tag === "Identical")) return Verdict.Identical();
  return Verdict.Widens({ reasons });
};

const KNOWN_KEYWORDS = new Set([
  "$schema",
  "$defs",
  "$ref",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "title",
  "description",
  "examples",
]);

const compare = (
  fromNode: unknown,
  toNode: unknown,
  fromRoot: Doc,
  toRoot: Doc,
  path: string,
  seen: ReadonlySet<string>
): Verdict => {
  const at = path === "" ? "the root" : path;

  const fromEncoded = CanonicalJson.encodeOrThrow(fromNode as CanonicalJson.CanonicalValue); // prettier-ignore
  const toEncoded = CanonicalJson.encodeOrThrow(toNode as CanonicalJson.CanonicalValue); // prettier-ignore
  // Byte-identical settles it only when nothing here points elsewhere. Two
  // documents can carry the same `$ref` string into different `$defs`, and
  // shortcutting on the pointer rather than the target would report a
  // narrowing as unchanged.
  if (fromEncoded === toEncoded && !fromEncoded.includes('"$ref"')) {
    return Verdict.Identical();
  }

  if (isDoc(fromNode) && isDoc(toNode) && (fromNode.$ref || toNode.$ref)) {
    const pair = `${String(fromNode.$ref)}|${String(toNode.$ref)}`;
    // A recursive schema would otherwise expand forever. Refusing to decide is
    // the sound answer; the caller falls back to validating instances.
    if (seen.has(pair)) {
      return Verdict.Unknown({ reasons: [`${at} is recursive`] });
    }
    seen = new Set(seen).add(pair);
  }

  const from = deref(fromNode, fromRoot);
  const to = deref(toNode, toRoot);

  if (from === undefined || to === undefined) {
    return Verdict.Unknown({ reasons: [`unresolvable $ref at ${at}`] });
  }
  if (!isDoc(from) || !isDoc(to)) {
    return Verdict.Unknown({ reasons: [`non-object schema at ${at}`] });
  }

  // An empty schema accepts everything, so anything widens into it.
  if (Object.keys(to).filter((k) => k !== "$schema").length === 0) {
    return Verdict.Widens({ reasons: [`${at} became unconstrained`] });
  }

  for (const [node, side] of [
    [from, "old"],
    [to, "new"],
  ] as const) {
    const unhandled = Object.keys(node).filter((k) => !KNOWN_KEYWORDS.has(k));
    if (unhandled.length > 0) {
      return Verdict.Unknown({
        reasons: [`${side} schema at ${at} uses ${unhandled.join(", ")}`],
      });
    }
  }

  const verdicts: Verdict[] = [];

  if (
    typeof from.type === "string" &&
    typeof to.type === "string" &&
    from.type !== to.type
  ) {
    return Verdict.Narrows({
      reasons: [`${at} changed type from ${from.type} to ${to.type}`],
    });
  }

  // `enum` is a closed set of allowed values.
  const fromEnum = from.enum ?? from.const;
  const toEnum = to.enum ?? to.const;
  if (toEnum !== undefined) {
    if (fromEnum === undefined) {
      return Verdict.Narrows({
        reasons: [`${at} became a closed set of values`],
      });
    }
    const allowed = encodedSet(Array.isArray(toEnum) ? toEnum : [toEnum]);
    const missing =
      [...encodedSet(Array.isArray(fromEnum) ? fromEnum : [fromEnum])] // prettier-ignore
        .filter((value) => !allowed.has(value));
    if (missing.length > 0) {
      return Verdict.Narrows({
        reasons: [`${at} no longer allows ${missing.join(", ")}`],
      });
    }
    verdicts.push(Verdict.Widens({ reasons: [`${at} allows more values`] }));
  } else if (fromEnum !== undefined) {
    verdicts.push(Verdict.Widens({ reasons: [`${at} dropped its value set`] }));
  }

  if (isDoc(from.properties) || isDoc(to.properties)) {
    const fromProps = isDoc(from.properties) ? from.properties : {};
    const toProps = isDoc(to.properties) ? to.properties : {};
    const fromRequired = new Set(stringsOf(from.required));
    const toRequired = stringsOf(to.required);
    const toClosed = to.additionalProperties === false;

    // Requiring something that used to be optional rejects instances that
    // omitted it.
    const newlyRequired = toRequired.filter((key) => !fromRequired.has(key));
    if (newlyRequired.length > 0) {
      return Verdict.Narrows({
        reasons: [`${at} now requires ${newlyRequired.join(", ")}`],
      });
    }
    if (fromRequired.size > toRequired.length) {
      verdicts.push(
        Verdict.Widens({ reasons: [`${at} requires fewer properties`] })
      );
    }

    for (const [key, fromProp] of Object.entries(fromProps)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (key in toProps) {
        verdicts.push(
          compare(fromProp, toProps[key], fromRoot, toRoot, childPath, seen)
        );
      } else if (toClosed) {
        // The instance may carry this property; a closed schema rejects it.
        return Verdict.Narrows({
          reasons: [`${at} no longer accepts property ${key}`],
        });
      }
    }

    const added = Object.keys(toProps).filter((key) => !(key in fromProps));
    if (added.length > 0) {
      verdicts.push(
        Verdict.Widens({
          reasons: [`${at} accepts new optional ${added.join(", ")}`],
        })
      );
    }

    if (
      from.additionalProperties === false &&
      to.additionalProperties !== false
    ) {
      verdicts.push(
        Verdict.Widens({ reasons: [`${at} now accepts extra properties`] })
      );
    }
  }

  if (from.items !== undefined || to.items !== undefined) {
    if (from.items === undefined || to.items === undefined) {
      return Verdict.Unknown({ reasons: [`${at} changed its item schema`] });
    }
    verdicts.push(compare(from.items, to.items, fromRoot, toRoot, `${at}[]`, seen)); // prettier-ignore
  }

  if (verdicts.length === 0) {
    return Verdict.Unknown({ reasons: [`${at} differs in an unmodelled way`] });
  }

  return worst(verdicts);
};

/**
 * Does every instance valid under `from` remain valid under `to`?
 *
 * Both arguments are `SchemaId` descriptors, so the comparison runs on the same
 * normalised JSON Schema the content id was computed over - the thing actually
 * recorded in the schema log, not a live `Schema` that may since have changed.
 * That matters: this question gets asked about shapes whose code is gone.
 */
export const subsumes = (
  from: SchemaId.SchemaDescriptor,
  to: SchemaId.SchemaDescriptor
): Verdict => {
  if (from.cid === to.cid) return Verdict.Identical();
  const fromRoot = from.jsonSchema as Doc;
  const toRoot = to.jsonSchema as Doc;
  if (!isDoc(fromRoot) || !isDoc(toRoot)) {
    return Verdict.Unknown({ reasons: ["schema document is not an object"] });
  }
  return compare(fromRoot, toRoot, fromRoot, toRoot, "", new Set());
};

export class SchemaViolation extends Data.TaggedError("SchemaViolation")<{
  readonly schemaCid: string;
  readonly message: string;
}> {}

/**
 * Instance-level fallback for when `subsumes` returns `Unknown` or `Narrows`.
 *
 * A `Narrows` verdict says *some* instance breaks, not that this one does: a
 * schema that drops an enum member is a narrowing, but config that never used
 * that member is still fine. Deciding that needs the value, and a live `Schema`
 * to decide it with.
 */
export const accepts = <A, I>(
  schema: import("effect").Schema.Schema<A, I>,
  instance: unknown
): Effect.Effect<boolean> =>
  SchemaId.normalizeThrough(schema, instance).pipe(
    Effect.as(true),
    Effect.catchTag("ParseError", () => Effect.succeed(false))
  );
