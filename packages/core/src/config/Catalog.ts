/**
 * Rules as configuration.
 *
 * Until now `BoolExpr` was free-floating: a predicate had a content id but no
 * version, no place in the graph, and nothing connecting a rule change to the
 * decisions it had already produced. That left two content-addressed systems
 * side by side, which is two coincidences rather than one principle.
 *
 * A rule here is an ordinary `ConfigNode`. That buys three things at once and
 * they are the point of the join:
 *
 * - **One graph.** A rule that calls another rule records a `ref`, so
 *   `ConfigNode.closureId` already answers "would this rule behave differently"
 *   when a shared sub-rule moves - the same machinery that answers it for a
 *   form reading a retyped attribute.
 * - **One invalidation path.** Resolving a rule during evaluation observes its
 *   content id, exactly the way reading a fact observes a value. Config changes
 *   and fact changes then flow through the same closure and the same cache;
 *   there is no config-watcher bolted on beside the fact-watcher.
 * - **Pinning for free.** An evaluation carries the rule's cid in its own id,
 *   so an answer decided under v3 is not merely labelled v3 - it is a different
 *   object from the v4 answer and the cache cannot serve one for the other.
 */

import * as BoolExpr from "./BoolExpr";
import * as ConfigNode from "./ConfigNode";
import * as ContentId from "../content/ContentId";

export const RULE_KIND = "rule";

export interface Catalog {
  readonly rules: ReadonlyMap<
    string,
    { readonly expr: BoolExpr.BoolExpr; readonly cid: ContentId.ContentId }
  >;
}

export const empty: Catalog = { rules: new Map() };

/**
 * A rule as a node in the config graph.
 *
 * The refs are derived from the expression rather than declared by the caller,
 * so a rule cannot claim a dependency set that differs from the one it will
 * actually resolve. That is the same discipline `BoolExpr` uses for facts: what
 * it can reach is visible in its structure.
 */
export const ruleNode = (
  key: string,
  expr: BoolExpr.BoolExpr,
): ReturnType<typeof ConfigNode.make> =>
  ConfigNode.make({
    kind: RULE_KIND,
    key,
    attrs: { expr: expr as never },
    refs: BoolExpr.mentionsRules(expr).map((target) => ({
      rel: "calls",
      kind: RULE_KIND,
      key: target,
    })),
  });

/** Build a catalog from rule nodes - typically the rules in one snapshot. */
export const fromNodes = (nodes: ReadonlyArray<ConfigNode.ConfigNode>): Catalog => {
  const rules = new Map<string, { expr: BoolExpr.BoolExpr; cid: ContentId.ContentId }>();
  for (const node of nodes) {
    if (node.kind !== RULE_KIND) continue;
    const attrs = node.attrs as { readonly expr?: unknown };
    if (attrs.expr === undefined) continue;
    rules.set(node.key, {
      expr: attrs.expr as BoolExpr.BoolExpr,
      cid: node.cid,
    });
  }
  return { rules };
};

export const lookup = (
  catalog: Catalog,
  key: string,
): { readonly expr: BoolExpr.BoolExpr; readonly cid: ContentId.ContentId } | undefined =>
  // prettier-ignore
  catalog.rules.get(key);
