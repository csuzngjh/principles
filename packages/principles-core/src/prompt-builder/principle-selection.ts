/**
 * Budget-Aware Principle Selection
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 2
 *
 * Pure functions for selecting and formatting principles within a character budget.
 * No I/O dependencies — suitable for any host.
 */

import type { PrinciplePriority } from '../runtime-v2/types/principle-enums.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal principle shape required for injection selection.
 * Accepts both evolution-types.Principle and principle-tree-schema.Principle.
 */
export interface InjectablePrinciple {
  id: string;
  text: string;
  /** Priority level. Defaults to 'P1' if not set by the source. */
  priority?: PrinciplePriority;
  /** ISO date string. Required for recency ordering in selectPrinciplesForInjection. */
  createdAt: string;
}

/**
 * Result of principle selection for injection.
 */
export interface PrincipleSelectionResult {
  /** Selected principles in injection order (priority-first, then recency) */
  selected: InjectablePrinciple[];
  /** Total character count of selected principles' formatted output */
  totalChars: number;
  /** Number of principles by priority tier */
  breakdown: {
    p0: number;
    p1: number;
    p2: number;
  };
  /** Whether at least one P0 principle was included */
  hasP0: boolean;
  /** Whether the selection was truncated due to budget */
  wasTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Priority Ordering
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<PrinciplePriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

/**
 * Compare two principles for sorting.
 * Primary: priority (P0 < P1 < P2 — lower is higher priority).
 * Secondary: recency (newer createdAt first).
 */
function comparePrinciples(a: InjectablePrinciple, b: InjectablePrinciple): number {
  const INVALID_PRIORITY_RANK = 99;
  const priorityA = PRIORITY_ORDER[a.priority ?? 'P1'] ?? INVALID_PRIORITY_RANK;
  const priorityB = PRIORITY_ORDER[b.priority ?? 'P1'] ?? INVALID_PRIORITY_RANK;

  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }

  // Same priority: sort by recency (newer first)
  // Date.parse is robust to non-ISO-8601 formats unlike localeCompare on raw strings
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a single principle for injection.
 * Returns the formatted string including ID and text.
 *
 * Format: "- [ID] text" (matches existing prompt.ts format)
 */
export function formatPrinciple(p: InjectablePrinciple): string {
  return `- [${p.id}] ${p.text}`;
}

/**
 * Calculate the character length of a formatted principle, including newline.
 */
function formattedLength(p: InjectablePrinciple): number {
  return formatPrinciple(p).length + 1; // +1 for newline separator
}

// ---------------------------------------------------------------------------
// Selection Algorithm
// ---------------------------------------------------------------------------

/**
 * Select principles for prompt injection within a character budget.
 *
 * Algorithm:
 *  1. Sort all principles by priority (P0 > P1 > P2), then by recency
 *  2. Iterate through sorted principles, accumulating character count
 *  3. Stop when adding the next principle would exceed budgetChars
 *  4. Ensure at least one P0 principle is included (even if it exceeds budget)
 *
 * @param principles - All available principles to select from
 * @param budgetChars - Maximum character budget for formatted output
 * @returns Selection result with chosen principles and metadata
 */
export function selectPrinciplesForInjection(
  principles: InjectablePrinciple[],
  budgetChars: number,
): PrincipleSelectionResult {
  if (principles.length === 0) {
    return {
      selected: [],
      totalChars: 0,
      breakdown: { p0: 0, p1: 0, p2: 0 },
      hasP0: false,
      wasTruncated: false,
    };
  }

  // Sort by priority then recency
  const sorted = [...principles].sort(comparePrinciples);

  const selected: InjectablePrinciple[] = [];
  let totalChars = 0;
  let p0Included = false;
  let wasTruncated = false;

  for (const principle of sorted) {
    const cost = formattedLength(principle);

    // Check if adding this principle would exceed budget
    if (totalChars + cost > budgetChars) {
      // Special case: if no P0 has been included yet, force-include the first P0
      // even if it exceeds the budget (P0 principles are critical)
      if (!p0Included && principle.priority === 'P0') {
        selected.push(principle);
        totalChars += cost;
        p0Included = true;
        wasTruncated = true;
        // Continue to try to fit more principles after this forced inclusion
        continue;
      }

      wasTruncated = true;
      // Continue evaluating remaining principles — a smaller one that fits may exist
      continue;
    }

    selected.push(principle);
    totalChars += cost;
    if (principle.priority === 'P0') {
      p0Included = true;
    }
  }

  // Safety net: if we went through all principles and still no P0 included
  // (because P0 was beyond budget threshold), force-include the first P0
  if (!p0Included) {
    const firstP0 = sorted.find(p => p.priority === 'P0');
    if (firstP0 && !selected.includes(firstP0)) {
      // Insert P0 at the beginning of selected (highest priority)
      selected.unshift(firstP0);
      totalChars += formattedLength(firstP0);
      p0Included = true;
    }
  }

  const breakdown = {
    p0: selected.filter(p => (p.priority ?? 'P1') === 'P0').length,
    p1: selected.filter(p => (p.priority ?? 'P1') === 'P1').length,
    p2: selected.filter(p => (p.priority ?? 'P1') === 'P2').length,
  };

  return {
    selected,
    totalChars,
    breakdown,
    hasP0: p0Included,
    wasTruncated,
  };
}

// ---------------------------------------------------------------------------
// Default Budget
// ---------------------------------------------------------------------------

/**
 * Default character budget for principle injection.
 * 4000 characters is ~800 tokens, leaving ample room for other prompt sections
 * within the 10K character injection limit.
 */
export const DEFAULT_PRINCIPLE_BUDGET = 4000;
