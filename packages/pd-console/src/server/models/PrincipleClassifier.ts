/**
 * PrincipleClassifier — Read model that classifies principles into
 * owner-actionable vs noise categories.
 *
 * Categories:
 *  - owner_actionable: Needs a real governance decision (pending, probation, candidate)
 *  - demo: Demo / example principles planted by the framework
 *  - smoke: Smoke-test principles for CI validation
 *  - historical: Archived or deprecated principles (already decided long ago)
 *  - builtin: Core Thinking OS axioms (registry T-NN ids) — not governance targets
 *  - already_decided: Approved / rejected via approval queue
 *
 * Classification is purely read-side; it does NOT mutate any data.
 */

import type { PrincipleListItem } from './PrinciplesConsoleModel.js';
import { isCorePrincipleId } from '@principles/core/runtime-v2';

// ── Public types ──────────────────────────────────────────────────────────────

export type PrincipleCategory =
  | 'owner_actionable'
  | 'in_pipeline'
  | 'demo'
  | 'smoke'
  | 'historical'
  | 'builtin'
  | 'already_decided';

export interface ClassifiedPrinciple {
  principle: PrincipleListItem;
  category: PrincipleCategory;
}

// ── Heuristics ────────────────────────────────────────────────────────────────

/** ID prefixes that indicate demo / dogfood data */
const DEMO_ID_PREFIXES = ['DEMO_', 'demo_', 'story-a', 'story_a', 'dogfood_'];

/** ID prefixes that indicate smoke / test data */
const SMOKE_ID_PREFIXES = ['SMOKE_', 'smoke_', 'probe_', 'test_principle_'];

/** Substrings that indicate demo/smoke principles (only matched in ID, not in text) */
const DEMO_ID_KEYWORDS = ['demo', 'example', 'sample', 'placeholder'];
const SMOKE_ID_KEYWORDS = ['smoke', 'smoketest', 'smoke_test', 'probe'];

/** Substrings in text that indicate demo/smoke — more restrictive than ID matching */
const DEMO_TEXT_KEYWORDS = ['[demo]', '[example]', '[placeholder]'];
const SMOKE_TEXT_KEYWORDS = ['[smoke]', '[smoketest]'];

function hasPrefix(id: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => id.toLowerCase().startsWith(p.toLowerCase()));
}

function hasKeyword(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

/**
 * Core Thinking OS axiom IDs — validated against the @principles/core
 * registry so the builtin set always mirrors the canonical T-01..T-10.
 */
function isBuiltinId(id: string): boolean {
  return isCorePrincipleId(id);
}

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * Classify a single principle. Order matters — earlier checks win.
 *
 * @param p - The principle to classify
 * @param decidedPrincipleIds - Set of principle IDs that have been decided
 *   via the approval queue (approved or rejected). These should be classified
 *   as already_decided regardless of their ledger status.
 */
export function classifyPrinciple(
  p: PrincipleListItem,
  decidedPrincipleIds?: Set<string>,
  pendingApprovalPrincipleIds?: Set<string>,
): PrincipleCategory {
  // 1. Builtin axioms (T-01..T-10) are never governance targets
  if (isBuiltinId(p.id)) {
    return 'builtin';
  }

  // 2. Demo / dogfood principles — ID prefix is primary signal
  if (hasPrefix(p.id, DEMO_ID_PREFIXES) || hasKeyword(p.id, DEMO_ID_KEYWORDS)) {
    return 'demo';
  }
  // Text matching is intentionally restrictive (bracketed tags only) to avoid
  // false positives on real principles that happen to mention "sample" or "template"
  if (hasKeyword(p.text + p.triggerPattern, DEMO_TEXT_KEYWORDS)) {
    return 'demo';
  }

  // 3. Smoke test principles — ID prefix is primary signal
  if (hasPrefix(p.id, SMOKE_ID_PREFIXES) || hasKeyword(p.id, SMOKE_ID_KEYWORDS)) {
    return 'smoke';
  }
  if (hasKeyword(p.text + p.triggerPattern, SMOKE_TEXT_KEYWORDS)) {
    return 'smoke';
  }

  // 4. Already decided via approval queue (approved or rejected)
  //    This catches principles whose ledger status is still 'candidate' but
  //    have been decided through the approval workflow.
  if (decidedPrincipleIds && decidedPrincipleIds.has(p.id)) {
    return 'already_decided';
  }

  // 4b. PRI-629: a PENDING approval is a real Owner decision — owner_actionable
  //     (INV-01: actionability requires an executable action, and it exists here).
  if (pendingApprovalPrincipleIds && pendingApprovalPrincipleIds.has(p.id)) {
    return 'owner_actionable';
  }

  // 5. Already decided: active = approved & in effect, no governance needed
  if (p.status === 'active') {
    return 'already_decided';
  }

  // 6. Historical: archived or deprecated
  if (p.status === 'archived' || p.status === 'deprecated') {
    return 'historical';
  }

  // 7. candidate / probation = 内化管线进行中 (PRI-629 INV-02: lifecycle ≠
  //    Owner attention)。真正的 Owner 决策由治理焦点的 Owner Decision
  //    投影呈现;此处不再产生假"待审查"。
  return 'in_pipeline';
}

/**
 * Classify a batch of principles. Returns the classified array.
 *
 * @param principles - The principles to classify
 * @param decidedPrincipleIds - Set of principle IDs that have been decided
 *   via the approval queue (approved or rejected).
 */
export function classifyPrinciples(
  principles: PrincipleListItem[],
  decidedPrincipleIds?: Set<string>,
  pendingApprovalPrincipleIds?: Set<string>,
): ClassifiedPrinciple[] {
  return principles.map((p) => ({ principle: p, category: classifyPrinciple(p, decidedPrincipleIds, pendingApprovalPrincipleIds) }));
}

/**
 * Filter to only owner-actionable principles.
 */
export function filterOwnerActionable(
  classified: ClassifiedPrinciple[],
): ClassifiedPrinciple[] {
  return classified.filter((c) => c.category === 'owner_actionable');
}


