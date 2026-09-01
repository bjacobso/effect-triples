/**
 * A bounded three-valued predicate language over facts.
 *
 * Small on purpose, and the smallness is a correctness property rather than a
 * scoping convenience. Every read an expression can perform is visible in its
 * own structure, so the dependency set is knowable and the evaluator cannot
 * consult something it did not declare. The moment the language grows a general
 * function call or a closure, that guarantee is gone and every cached result
 * becomes a guess - so this stays a fixed set of constructors with no escape
 * hatch, like `TypeExpr`.
 *
 * Evaluation is three-valued (`true` / `false` / `unknown`) and that is not the
 * same question `TypeSubsumption` answers. Type subsumption is decidable over a
 * closed algebra, so it has no `unknown`. Predicate evaluation runs against a
 * world where a fact may simply be absent, and collapsing that to `false` is
 * how a negated predicate accidentally reports compliance. The two layers are
 * both right.
 */

import * as CanonicalJson from "../content/CanonicalJson";
import * as ContentId from "../content/ContentId";

export interface Lit {
  readonly _tag: "Lit";
  readonly v: 1;
  readonly value: boolean;
}
export interface Exists {
  readonly _tag: "Exists";
  readonly v: 1;
  readonly entity: string;
  readonly attribute: string;
}
export interface Eq {
  readonly _tag: "Eq";
  readonly v: 1;
  readonly entity: string;
  readonly attribute: string;
  readonly value: string | number | boolean;
}
/** Reads an instant-valued fact and compares it to the clock. */
export interface Before {
  readonly _tag: "Before";
  readonly v: 1;
  readonly entity: string;
  readonly attribute: string;
  readonly granularity: "instant" | "day";
}
/**
 * Call another rule by key.
 *
 * The one node that reaches outside the world into the *config* graph. It is
 * still bounded - the key is right there in the structure, so what a rule can
 * reach remains statically visible and the dependency set stays honest.
 */
export interface Rule {
  readonly _tag: "Rule";
  readonly v: 1;
  readonly key: string;
}

export interface Not {
  readonly _tag: "Not";
  readonly v: 1;
  readonly expr: BoolExpr;
}
export interface All {
  readonly _tag: "All";
  readonly v: 1;
  readonly exprs: ReadonlyArray<BoolExpr>;
}
export interface Any {
  readonly _tag: "Any";
  readonly v: 1;
  readonly exprs: ReadonlyArray<BoolExpr>;
}

export type BoolExpr = Lit | Exists | Eq | Before | Rule | Not | All | Any;

export const lit = (value: boolean): Lit => ({ _tag: "Lit", v: 1, value });

export const exists = (entity: string, attribute: string): Exists => ({
  _tag: "Exists",
  v: 1,
  entity,
  attribute,
});

export const eq = (entity: string, attribute: string, value: string | number | boolean): Eq => ({
  _tag: "Eq",
  v: 1,
  entity,
  attribute,
  value,
});

export const before = (
  entity: string,
  attribute: string,
  granularity: "instant" | "day" = "day",
): Before => ({ _tag: "Before", v: 1, entity, attribute, granularity });

export const rule = (key: string): Rule => ({ _tag: "Rule", v: 1, key });

export const not = (expr: BoolExpr): Not => ({ _tag: "Not", v: 1, expr });

export const all = (exprs: ReadonlyArray<BoolExpr>): All => ({
  _tag: "All",
  v: 1,
  exprs,
});

export const any = (exprs: ReadonlyArray<BoolExpr>): Any => ({
  _tag: "Any",
  v: 1,
  exprs,
});

export const canonical = (expr: BoolExpr): string =>
  CanonicalJson.encodeOrThrow(expr as unknown as CanonicalJson.CanonicalValue);

export const id = (expr: BoolExpr): ContentId.ContentId =>
  ContentId.hash(ContentId.Domain.boolExpr, canonical(expr));

/**
 * Every fact this expression *could* read, without evaluating it.
 *
 * Available because the language is bounded. Note this is the static
 * over-approximation - `Any` short-circuits, so a run may observe fewer. The
 * cache keys on what was *actually* observed, not on this; this is for indexes
 * and impact analysis ("which predicates mention `employee.start_date`?").
 */
export const mentions = (expr: BoolExpr): ReadonlyArray<{ entity: string; attribute: string }> => {
  switch (expr._tag) {
    case "Lit":
      return [];
    case "Exists":
    case "Eq":
    case "Before":
      return [{ entity: expr.entity, attribute: expr.attribute }];
    case "Rule":
      // A call's reads live in the callee, which this function cannot see.
      // `mentionsRules` covers that edge; resolving it needs a catalog.
      return [];
    case "Not":
      return mentions(expr.expr);
    case "All":
    case "Any":
      return expr.exprs.flatMap(mentions);
  }
};

/** Rules this expression calls directly. Used to derive a rule node's refs. */
export const mentionsRules = (expr: BoolExpr): ReadonlyArray<string> => {
  switch (expr._tag) {
    case "Lit":
    case "Exists":
    case "Eq":
    case "Before":
      return [];
    case "Rule":
      return [expr.key];
    case "Not":
      return mentionsRules(expr.expr);
    case "All":
    case "Any":
      return expr.exprs.flatMap(mentionsRules);
  }
};
