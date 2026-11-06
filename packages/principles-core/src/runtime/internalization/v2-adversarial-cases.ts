/** Pure v2 RuleContext boundary cases. */
import type { CanonicalKind } from './rule-context-v2.js';
import { UNAVAILABLE_RULE_CONTEXT, type RuleContextV2, type RuleHistoryWindow, type RuleBehaviorFacts } from './rule-context-v2.js';
import type { AdversarialCase } from './evaluator-output.js';

export interface V2AdversarialCaseSpec {
  readonly toolName: string;
  readonly targetPath: string;
  readonly canonicalKind: CanonicalKind;
}

function makeContext(truncated: boolean): RuleContextV2 {
  const history: RuleHistoryWindow = { status: 'available', truncated, calls: [] };
  const facts: RuleBehaviorFacts = {
    priorReadOfTarget: 'unknown', readCount: null, writeCount: null,
    uniqueWritePathCount: null, sameActionBlockCount: null,
  };
  return { version: 2, history, facts };
}

/**
 * These two cases exercise only host-context availability. Principle-specific
 * action policies (path boundaries, aliases and risk combinations) must be
 * supported by the current Owner-labelled examples before they are replayed;
 * the generator must not invent those decisions from path names or generic
 * read-before-write assumptions.
 */
export function generateV2ContextAdversarialCases(spec: V2AdversarialCaseSpec): readonly AdversarialCase[] {
  return [
    {
      caseId: 'v2-unavailable', attackType: 'boundary', toolName: spec.toolName,
      params: { path: spec.targetPath }, expectedDecision: 'allow',
      rationale: 'history is unavailable, so absent context is not evidence that the Owner-defined action condition failed',
      ruleContext: UNAVAILABLE_RULE_CONTEXT,
    },
    {
      caseId: 'v2-truncated', attackType: 'omission', toolName: spec.toolName,
      params: { path: spec.targetPath }, expectedDecision: 'allow',
      rationale: 'history was truncated; missing calls cannot establish a negative fact outside the Owner-defined action condition',
      ruleContext: makeContext(true),
    },
  ];
}
