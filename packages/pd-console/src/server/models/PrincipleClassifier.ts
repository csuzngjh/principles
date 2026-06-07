/**
 * PrincipleClassifier — Read model that classifies principles into
 * owner-actionable vs noise categories.
 *
 * Categories:
 *  - owner_actionable: Needs a real governance decision (pending, probation, candidate)
 *  - demo: Demo / example principles planted by the framework
 *  - smoke: Smoke-test principles for CI validation
 *  - historical: Archived or deprecated principles (already decided long ago)
 *  - builtin: Core Thinking OS axioms (T-01..T-10) — not governance targets
 *  - already_decided: Approved / rejected via approval queue
 *
 * Classification is purely read-side; it does NOT mutate any data.
 */

import type { PrincipleListItem } from './PrinciplesConsoleModel.js';

// ── Public types ──────────────────────────────────────────────────────────────

export type PrincipleCategory =
  | 'owner_actionable'
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

/** IDs that are known builtin Thinking OS axioms */
const BUILTIN_ID_PREFIXES = ['T-0', 'T-1']; // T-01..T-10

/** Substrings that indicate demo/smoke principles */
const DEMO_KEYWORDS = ['demo', 'example', 'sample', 'template', 'placeholder'];
const SMOKE_KEYWORDS = ['smoke', 'smoketest', 'smoke_test'];

function hasKeyword(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function isBuiltinId(id: string): boolean {
  return BUILTIN_ID_PREFIXES.some((p) => id.startsWith(p));
}

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * Classify a single principle. Order matters — earlier checks win.
 */
export function classifyPrinciple(
  p: PrincipleListItem,
): PrincipleCategory {
  // 1. Builtin axioms (T-01..T-10) are never governance targets
  if (isBuiltinId(p.id)) {
    return 'builtin';
  }

  // 2. Demo / example principles
  if (hasKeyword(p.id + p.text + p.triggerPattern, DEMO_KEYWORDS)) {
    return 'demo';
  }

  // 3. Smoke test principles
  if (hasKeyword(p.id + p.text + p.triggerPattern, SMOKE_KEYWORDS)) {
    return 'smoke';
  }

  // 4. Historical: archived or deprecated = already decided long ago
  if (p.status === 'archived' || p.status === 'deprecated') {
    return 'historical';
  }

  // 5. Everything else that is candidate / probation / active is actionable
  return 'owner_actionable';
}

/**
 * Classify a batch of principles. Returns the classified array.
 */
export function classifyPrinciples(
  principles: PrincipleListItem[],
): ClassifiedPrinciple[] {
  return principles.map((p) => ({ principle: p, category: classifyPrinciple(p) }));
}

/**
 * Filter to only owner-actionable principles.
 */
export function filterOwnerActionable(
  classified: ClassifiedPrinciple[],
): ClassifiedPrinciple[] {
  return classified.filter((c) => c.category === 'owner_actionable');
}

// ── Approval-side classification ──────────────────────────────────────────────

/**
 * Classify an approval record. Approvals that are already decided
 * (approved / rejected / cancelled) are "already_decided".
 */
export function classifyApprovalStatus(status: string): PrincipleCategory {
  if (status === 'approved' || status === 'rejected' || status === 'cancelled') {
    return 'already_decided';
  }
  // pending → falls through to owner_actionable (subject to other filters)
  return 'owner_actionable';
}
