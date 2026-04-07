/**
 * Rule Host Helpers — Minimal whitelisted helper surface for hosted implementations
 *
 * PURPOSE: Provide a constrained set of pure functions that hosted implementations
 * can call. All values are pre-computed from the frozen RuleHostInput snapshot.
 *
 * SECURITY:
 *   - Helpers are a frozen object — cannot be modified by implementations
 *   - No filesystem, process, require, dynamic import, eval, Function, or network access
 *   - All functions are pure — no side effects, no external state access
 */

import type { RuleHostInput } from './rule-host-types.js';

export interface RuleHostHelpers {
  isRiskPath(): boolean;
  getToolName(): string;
  getEstimatedLineChanges(): number;
  getBashRisk(): 'safe' | 'normal' | 'dangerous' | 'unknown';
  hasPlanFile(): boolean;
  getPlanStatus(): 'NONE' | 'DRAFT' | 'READY' | 'UNKNOWN';
  getCurrentEpiTier(): number;
}

/**
 * Create a frozen helper object from the pre-computed input snapshot.
 * Implementations receive this via the vm context — they cannot modify it.
 */
export function createRuleHostHelpers(input: RuleHostInput): RuleHostHelpers {
  return Object.freeze({
    isRiskPath: () => input.workspace.isRiskPath,
    getToolName: () => input.action.toolName,
    getEstimatedLineChanges: () => input.derived.estimatedLineChanges,
    getBashRisk: () => input.derived.bashRisk,
    hasPlanFile: () => input.workspace.hasPlanFile,
    getPlanStatus: () => input.workspace.planStatus,
    getCurrentEpiTier: () => input.evolution.epTier,
  });
}
