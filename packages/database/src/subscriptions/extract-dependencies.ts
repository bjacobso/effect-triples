/**
 * Extract Dependencies from Datalog Queries
 *
 * Statically analyzes a Datalog query to extract what it reads,
 * enabling efficient invalidation checks without re-running queries.
 */

import {
  isPatternClause,
  isNotClause,
  isOrClause,
  isLinkClause,
  isRuleApplication,
  isVariable,
  isPredicateClause,
  type DatalogQuery,
  type Clause,
  type PatternClause,
  type NotClause,
  type OrClause,
  type LinkClause,
  type RuleApplication,
  type Term,
} from "../Datalog.js";
import type { QueryDependencies } from "./types.js";

// =============================================================================
// Entity Type Extraction
// =============================================================================

/**
 * Extract the entity type from an attribute.
 *
 * @example
 * extractEntityType(":employee/name") // "employee"
 * extractEntityType(":department/budget") // "department"
 * extractEntityType(":_link/type") // "_link"
 * extractEntityType("invalid") // null
 */
export function extractEntityType(attribute: string): string | null {
  if (!attribute.startsWith(":")) return null;
  const withoutColon = attribute.slice(1);
  const slashIndex = withoutColon.indexOf("/");
  if (slashIndex === -1) return null;
  return withoutColon.slice(0, slashIndex);
}

// =============================================================================
// Dependency Extraction
// =============================================================================

/**
 * Check if a term is a constant string (not a variable, not a number/boolean/object).
 */
function isConstantString(term: Term): term is string {
  return typeof term === "string" && !isVariable(term);
}

/**
 * Check if a term is an attribute (starts with :).
 */
function isAttribute(term: Term): term is string {
  return typeof term === "string" && term.startsWith(":");
}

/**
 * Infer the entity type from an entity ID using common naming conventions.
 * e.g., "emp:alice" → "employee" (prefix "emp"), "dept:eng" → "department" (prefix "dept")
 *
 * This uses heuristics and won't always be accurate, but provides a reasonable
 * default for entity ID → type mapping.
 */
function inferEntityTypeFromId(entityId: string): string | null {
  // Common prefix patterns: "emp:xxx" → employee, "dept:xxx" → department, etc.
  const colonIndex = entityId.indexOf(":");
  if (colonIndex > 0) {
    return entityId.slice(0, colonIndex);
  }
  return null;
}

/**
 * Extract dependencies from a Datalog query.
 *
 * Processes all clause types:
 * - Pattern clauses: extract attributes, entity types, bound entity IDs
 * - Not clauses: recursively process inner pattern
 * - Or clauses: process all patterns in the array
 * - Link clauses: add link type, add _link entity type attributes
 * - Rule applications: add rule name, extract bound args
 * - Predicate clauses: ignored (they filter, don't add read dependencies)
 *
 * @param query The Datalog query to analyze
 * @returns Dependencies describing what the query reads
 */
export function extractDependencies(query: DatalogQuery): QueryDependencies {
  const attributes = new Set<string>();
  const entityTypes = new Set<string>();
  const boundEntityIds = new Set<string>();
  const boundEntityTypes = new Set<string>();
  const linkTypes = new Set<string>();
  const ruleNames = new Set<string>();
  let hasDynamicAttributes = false;

  function processClause(clause: Clause): void {
    if (isPredicateClause(clause)) {
      // Predicate clauses (>, <, =, etc.) don't add read dependencies
      return;
    }
    if (isPatternClause(clause)) {
      processPatternClause(clause);
    } else if (isNotClause(clause)) {
      processNotClause(clause);
    } else if (isOrClause(clause)) {
      processOrClause(clause);
    } else if (isLinkClause(clause)) {
      processLinkClause(clause);
    } else if (isRuleApplication(clause)) {
      processRuleApplication(clause);
    }
  }

  function processPatternClause(pattern: PatternClause): void {
    const [entity, attr, _value] = pattern;

    // Extract attribute (if it's a constant attribute, not a variable)
    if (isAttribute(attr)) {
      attributes.add(attr);
      const entityType = extractEntityType(attr);
      if (entityType) entityTypes.add(entityType);

      // Extract bound entity ID (if entity position is a constant string, not a variable)
      if (isConstantString(entity) && !isAttribute(entity)) {
        boundEntityIds.add(entity);
        // Track which entity type this bound ID belongs to
        if (entityType) {
          boundEntityTypes.add(entityType);
        }
      }
    } else if (isVariable(attr)) {
      hasDynamicAttributes = true;

      if (isConstantString(entity) && !isAttribute(entity)) {
        boundEntityIds.add(entity);
      }
    }
  }

  function processNotClause(notClause: NotClause): void {
    // ["not", pattern] — the pattern inside also creates dependencies
    const [_not, pattern] = notClause;
    processPatternClause(pattern);
  }

  function processOrClause(orClause: OrClause): void {
    // ["or", [pattern1, pattern2, ...]] — all patterns create dependencies
    const [_or, patterns] = orClause;
    for (const pattern of patterns) {
      processPatternClause(pattern);
    }
  }

  function processLinkClause(linkClause: LinkClause): void {
    // ["link", relationshipType, source, target]
    const [_link, relationshipType, source, target] = linkClause;
    linkTypes.add(relationshipType);

    // Links read the _link entity type's attributes
    entityTypes.add("_link");
    attributes.add(":_link/type");
    attributes.add(":_link/source");
    attributes.add(":_link/target");

    // If source or target are constants, they're bound
    if (isConstantString(source) && !isAttribute(source)) {
      boundEntityIds.add(source);
      boundEntityTypes.add("_link");
    }
    if (isConstantString(target) && !isAttribute(target)) {
      boundEntityIds.add(target);
      boundEntityTypes.add("_link");
    }
  }

  function processRuleApplication(rule: RuleApplication): void {
    // ["ruleName", arg1, arg2] — record the rule name
    const [ruleName, arg1, arg2] = rule;
    ruleNames.add(ruleName);

    // If args are constants, they're bound (but we can't determine entity type from rules)
    if (isConstantString(arg1) && !isAttribute(arg1)) {
      boundEntityIds.add(arg1);
      // Try to infer entity type from ID
      const inferredType = inferEntityTypeFromId(arg1);
      if (inferredType) boundEntityTypes.add(inferredType);
    }
    if (isConstantString(arg2) && !isAttribute(arg2)) {
      boundEntityIds.add(arg2);
      const inferredType = inferEntityTypeFromId(arg2);
      if (inferredType) boundEntityTypes.add(inferredType);
    }
  }

  // Process all where clauses
  for (const clause of query.where) {
    processClause(clause);
  }

  return {
    attributes,
    hasDynamicAttributes,
    entityTypes,
    boundEntityIds,
    boundEntityTypes,
    linkTypes,
    ruleNames,
  };
}
