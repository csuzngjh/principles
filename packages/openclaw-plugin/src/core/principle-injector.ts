/**
 * PrincipleInjector interface for the Evolution SDK.
 *
 * Wraps the existing principle injection logic into a framework-agnostic
 * contract. Per D-05, this delegates to selectPrinciplesForInjection and
 * formatPrinciple without any behavioral changes.
 *
 * Per D-06, InjectionContext contains only generic fields (domain, sessionId,
 * budgetChars) -- no framework-specific fields.
 */
import type { InjectablePrinciple } from './principle-injection.js';
import { selectPrinciplesForInjection, formatPrinciple } from './principle-injection.js';

// ---------------------------------------------------------------------------
// InjectionContext
// ---------------------------------------------------------------------------

/** Generic injection context -- no framework-specific fields. */
export interface InjectionContext {
  /** Domain context (e.g., 'coding', 'writing', 'analysis') */
  domain: string;
  /** Session identifier */
  sessionId: string;
  /** Maximum characters allowed for injected principles */
  budgetChars: number;
}

// ---------------------------------------------------------------------------
// PrincipleInjector Interface
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic principle injection interface.
 *
 * Wraps the existing budget-aware selection and formatting logic.
 * Framework adapters convert their context to InjectionContext before calling.
 */
export interface PrincipleInjector {
  /**
   * Select principles relevant for injection within a character budget.
   * Delegates to selectPrinciplesForInjection from principle-injection.ts.
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
   * Delegates to formatPrinciple from principle-injection.ts.
   *
   * Format: "- [ID] text"
   *
   * @param principle - The principle to format
   * @returns Formatted string for prompt injection
   */
  formatForInjection(principle: InjectablePrinciple): string;
}

// ---------------------------------------------------------------------------
// Default Implementation
// ---------------------------------------------------------------------------

/**
 * Default implementation that delegates to existing functions.
 * Zero rewrite risk -- behavior is identical to calling the functions directly.
 */
export class DefaultPrincipleInjector implements PrincipleInjector {
  getRelevantPrinciples(
    principles: InjectablePrinciple[],
    context: InjectionContext,
  ): InjectablePrinciple[] {
    const result = selectPrinciplesForInjection(principles, context.budgetChars);
    return result.selected;
  }

  formatForInjection(principle: InjectablePrinciple): string {
    return formatPrinciple(principle);
  }
}
