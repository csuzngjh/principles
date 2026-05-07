/**
 * Principle Injection — Budget-Aware Principle Selection
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 2
 *
 * This file is now a thin re-export layer.
 * All pure logic lives in @principles/core/prompt-builder/principle-selection.ts.
 */

// Re-exported from core for backward compatibility with existing imports
export {
  formatPrinciple,
  selectPrinciplesForInjection,
  DEFAULT_PRINCIPLE_BUDGET,
} from '@principles/core/prompt-builder';
export type { InjectablePrinciple, PrincipleSelectionResult } from '@principles/core/prompt-builder';
