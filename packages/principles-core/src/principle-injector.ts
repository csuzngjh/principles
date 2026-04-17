/**
 * PrincipleInjector interface and DefaultPrincipleInjector implementation for the Evolution SDK.
 *
 * The DefaultPrincipleInjector is a minimal framework-agnostic implementation that:
 * - Sorts principles by priority (P0 first), then by creation date
 * - Selects principles that fit within budgetChars
 * - Always includes P0 principles (forced inclusion)
 * - Formats principles as "- [ID] text"
 *
 * This implementation does NOT depend on openclaw-plugin internals.
 * It uses only SDK types (InjectablePrinciple, InjectionContext).
 */
import type { InjectablePrinciple } from './types.js';

/**
 * Generic injection context -- no framework-specific fields.
 */
export interface InjectionContext {
  /** Domain context (e.g., 'coding', 'writing', 'analysis') */
  domain: string;
  /** Session identifier */
  sessionId: string;
  /** Maximum characters allowed for injected principles */
  budgetChars: number;
}

/**
 * Framework-agnostic principle injection interface.
 *
 * Wraps the existing budget-aware selection and formatting logic.
 * Framework adapters convert their context to InjectionContext before calling.
 */
export interface PrincipleInjector {
  /**
   * Select principles relevant for injection within a character budget.
   *
   * @param principles - All available principles to select from
   * @param context - Generic injection context with budget constraint
   * @returns Selected principles in injection order
   */
  getRelevantPrinciples(
    principles: InjectablePrinciple[],
    context: InjectionContext,
  ): InjectablePrinciple[];

  /**
   * Format a single principle for prompt injection.
   *
   * @param principle - The principle to format
   * @returns Formatted string for prompt injection
   */
  formatForInjection(principle: InjectablePrinciple): string;
}

/**
 * Priority order for principle selection.
 */
const PRIORITY_ORDER: Record<string, number> = {
  'P0': 0,
  'P1': 1,
  'P2': 2,
};

/**
 * Default implementation of PrincipleInjector.
 *
 * A minimal framework-agnostic injector using only SDK types.
 * Selection algorithm:
 * 1. Separate P0 principles (always included) from P1/P2
 * 2. Sort all principles by priority (P0 first), then by createdAt (oldest first)
 * 3. Fit P0 principles first, then P1/P2 until budgetChars is exhausted
 */
export class DefaultPrincipleInjector implements PrincipleInjector {
  getRelevantPrinciples(
    principles: InjectablePrinciple[],
    context: InjectionContext,
  ): InjectablePrinciple[] {
    if (!principles || principles.length === 0) {
      return [];
    }

    // Separate P0 from P1/P2
    const p0Principles = principles.filter((p) => p.priority === 'P0');
    const otherPrinciples = principles.filter((p) => p.priority !== 'P0');

    // Sort P0 by createdAt (oldest first)
    p0Principles.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Sort other principles by priority, then createdAt
    otherPrinciples.sort((a, b) => {
      const pA = PRIORITY_ORDER[a.priority ?? 'P1'] ?? 1;
      const pB = PRIORITY_ORDER[b.priority ?? 'P1'] ?? 1;
      if (pA !== pB) return pA - pB;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    // Build result: P0 first (forced), then others until budget exhausted
    const result: InjectablePrinciple[] = [];
    let usedChars = 0;

    // ALWAYS include P0 principles (forced inclusion, even if exceeds budget)
    for (const p of p0Principles) {
      const formatted = this.formatForInjection(p);
      result.push(p);
      usedChars += formatted.length;
    }

    // Add P1/P2 principles until budget exhausted
    for (const p of otherPrinciples) {
      const formatted = this.formatForInjection(p);
      if (usedChars + formatted.length <= context.budgetChars) {
        result.push(p);
        usedChars += formatted.length;
      }
    }

    return result;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  formatForInjection(principle: InjectablePrinciple): string {
    return `- [${principle.id}] ${principle.text}`;
  }
}
