/** Derived verification material. Never writes or completes historical Owner facts. */
import { extractExecutionConditions, isValidScribeExecutionConditionsV1 } from './intent-contract.js';
import { isDesignGateFact, type DesignGateFact } from './design-gate-facts.js';
import { UNAVAILABLE_RULE_CONTEXT, validateRuleContextV2 } from './rule-context-v2.js';
import type { GoldenTraceCase } from '../golden-trace.js';
import { buildGoldenTraceFromArtificer, validateGoldenTraceCase } from '../golden-trace.js';
import type { AdversarialCase } from './evaluator-output.js';

/** Only kinds with an existing runtime input schema and deterministic oracle. */
export function unsupportedRequiredRuleCodeFacts(conditions: { readonly requiredFacts: readonly { readonly required: boolean; readonly factKind: string }[] }): string[] {
  return [...new Set(conditions.requiredFacts.filter((fact) => fact.required && fact.factKind !== 'design_approval').map((fact) => fact.factKind))];
}

export interface RuleCodeVerificationCoverage {
  readonly required: readonly string[];
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly unavailable: readonly string[];
  readonly historical: readonly { readonly caseId: string; readonly qualification: 'direct_replay' | 'historical_evidence_only' | 'invalid_input'; readonly missingFacts: readonly string[] }[];
  readonly historicalCoverage: { readonly executed: number; readonly passed: number; readonly failed: number; readonly unavailable: number };
  readonly contractCoverage: { readonly required: number; readonly executed: number; readonly passed: number; readonly failed: number; readonly unavailable: number };
  readonly counterfactuals: readonly { readonly caseId: string; readonly source: 'system_counterfactual'; readonly contract: string }[];
}

export function deriveRuleCodeVerification(scribe: unknown, cases: readonly GoldenTraceCase[], tools: readonly { readonly rawToolName: string; readonly canonicalKind: string }[]) {
  const extracted = extractExecutionConditions(scribe);
  const required = [...new Set(extracted.conditions?.requiredFacts.filter((fact) => fact.required).map((fact) => fact.factKind) ?? [])];
  const unavailable = extracted.corrupted ? ['execution_conditions_corrupted'] : extracted.conditions === null ? [] : unsupportedRequiredRuleCodeFacts(extracted.conditions).map((kind) => `unsupported_required_fact:${kind}`);
  const design = required.includes('design_approval');
  const historical: RuleCodeVerificationCoverage['historical'][number][] = cases.map((entry) => {
    const fact = entry.ruleContext?.facts.designGate;
    const present = entry.ruleContext !== undefined && Object.hasOwn(entry.ruleContext.facts, 'designGate');
    const invalid = design && present && !isDesignGateFact(fact);
    const missingFacts = design && (!present || fact?.resolution === 'unknown') ? ['design_approval'] : [];
    return { caseId: entry.caseId, qualification: invalid ? 'invalid_input' : missingFacts.length > 0 ? 'historical_evidence_only' : 'direct_replay', missingFacts };
  });
  if (historical.some((entry) => entry.qualification === 'invalid_input')) unavailable.push('historical_fact_invalid');
  const replayCases = cases.filter((_, index) => historical[index]?.qualification === 'direct_replay');
  const counterfactuals: AdversarialCase[] = [];
  if (design && unavailable.length === 0) {
    // Names come from the existing host projection. The oracle below belongs
    // ONLY to DesignGate, whose host has already scoped this invocation.
    const actionTools = tools.filter((tool) => ['read', 'search', 'write', 'execute'].includes(tool.canonicalKind));
    if (!actionTools.some((tool) => ['write', 'execute'].includes(tool.canonicalKind))) unavailable.push('design_approval_action_projection_unavailable');
    for (const [index, tool] of actionTools.entries()) {
      const readonly = tool.canonicalKind === 'read' || tool.canonicalKind === 'search';
      const base: DesignGateFact = { version: 1, sourceRef: 'system-counterfactual:design-approval', revision: 1,
        requiresApproval: !readonly, taskRef: 'counterfactual-task', specDigest: 'counterfactual-spec', scopeRef: 'counterfactual-scope',
        decisionTaskRef: 'counterfactual-task', decisionSpecDigest: 'counterfactual-spec', decisionScopeRef: 'counterfactual-scope', resolution: readonly ? 'not_required' : 'not_approved', revoked: false };
      const variants: { name: string; fact?: DesignGateFact; expected: 'allow' | 'block' }[] = readonly
        ? [{ name: 'outside-scope', fact: base, expected: 'allow' }]
        : [
          { name: 'denied', fact: base, expected: 'block' },
          { name: 'approved', fact: { ...base, resolution: 'approved' }, expected: 'allow' },
          { name: 'not-required', fact: { ...base, requiresApproval: false, resolution: 'not_required' }, expected: 'allow' },
          { name: 'unknown', fact: { ...base, resolution: 'unknown', invalidationReason: 'source_unavailable' }, expected: 'allow' },
          { name: 'missing', expected: 'allow' },
          { name: 'revoked', fact: { ...base, revoked: true, invalidationReason: 'declaration_revoked' }, expected: 'block' },
          { name: 'binding-mismatch', fact: { ...base, decisionTaskRef: 'other-task', resolution: 'unknown', invalidationReason: 'task_mismatch' }, expected: 'allow' },
        ];
      const generatedActions = tool.canonicalKind === 'execute'
        ? [{ command: 'node -e "process.stdout.write(123)"' }, { command: 'python -c "print(456)"' }]
        : [{ path: '/counterfactual/first.ts', file_path: '/counterfactual/first.ts' }, { path: '/counterfactual/second.ts', file_path: '/counterfactual/second.ts' }];
      const actions = [
        ...generatedActions.map((params) => ({ params: { ...params, approved: true, designApproved: true }, seed: 'system-generated-action' })),
        // Preserve real managed action shapes under every fact state as well.
        // Read/search positives are not evidence of a managed approval scope.
        ...cases.filter((entry) => !readonly && entry.toolName === tool.rawToolName
          && (entry.kind === 'negative' || entry.ruleContext?.facts.designGate?.requiresApproval === true))
          .map((entry) => ({ params: entry.params, seed: `historical-action:${entry.caseId}` })),
      ];
      for (const [actionIndex, action] of actions.entries()) {
        for (const variant of variants) {
          counterfactuals.push({ caseId: `system-contract:design_approval:${index}:${actionIndex}:${variant.name}`, attackType: 'boundary', toolName: tool.rawToolName,
            params: { ...action.params }, expectedDecision: variant.expected,
            rationale: `system_counterfactual; contract=DesignGateFact/v1; seed=${action.seed}; ${variant.name}; synthetic invocation, never historical approval. Host scope is authoritative; params self-report is not.`,
            ruleContext: { ...UNAVAILABLE_RULE_CONTEXT, facts: { ...UNAVAILABLE_RULE_CONTEXT.facts, ...(variant.fact ? { designGate: variant.fact } : {}) } } });
        }
      }
      // PRI-1047 Owner review R6 #1: the one combination the variant table never
      // covered — not_approved × a host-classified READ-ONLY command on an
      // execute-kind tool must ALLOW. Read-only investigation (git status/rg/cat,
      // bashRisk "safe" under the shared classifier) is never a violation of a
      // pending approval; the gate face is mutating actions only. The R04
      // production artifact blocked exactly this shape and passed every
      // existing counterfactual because none of them asked it.
      if (tool.canonicalKind === 'execute') {
        counterfactuals.push({ caseId: `system-contract:design_approval:${index}:readonly:denied-readonly`, attackType: 'boundary', toolName: tool.rawToolName,
          params: { command: 'git status --short' }, expectedDecision: 'allow',
          rationale: `system_counterfactual; contract=DesignGateFact/v1; read-only investigation (host-safe bashRisk) under not_approved must stay allowed — the approval gate face is MUTATING actions only (PRI-1047 Owner review R6 #1).`,
          ruleContext: { ...UNAVAILABLE_RULE_CONTEXT, facts: { ...UNAVAILABLE_RULE_CONTEXT.facts, designGate: base } } });
      }
    }
  }
  return { required, unavailable, historical, replayCases, counterfactuals };
}

/** Existing system context injection, explicitly versioned and validated. */
function isOwnerVerificationCases(value: unknown): value is GoldenTraceCase[] {
  return Array.isArray(value) && value.every((entry: unknown) => validateGoldenTraceCase(entry).valid
    && typeof entry === 'object' && entry !== null
    && (!Object.hasOwn(entry, 'ruleContext') || validateRuleContextV2(Reflect.get(entry, 'ruleContext')).valid));
}

export function readRuleCodeVerificationContext(items: readonly { readonly role: string; readonly content: string }[]): { scribe: unknown; tools: { rawToolName: string; canonicalKind: string }[]; ownerCases?: readonly GoldenTraceCase[] } | undefined {
  let result: { scribe: unknown; tools: { rawToolName: string; canonicalKind: string }[]; ownerCases?: readonly GoldenTraceCase[] } | undefined;
  for (const item of items) {
    if (item.role !== 'system') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(item.content); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.hasOwn(parsed, 'ruleCodeVerification')) continue;
    const value: unknown = Reflect.get(parsed, 'ruleCodeVerification');
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Reflect.get(value, 'version') !== 1 || !isValidScribeExecutionConditionsV1(Reflect.get(value, 'executionConditions'))
      || !Array.isArray(Reflect.get(value, 'tools')) || result !== undefined) throw new Error('invalid_or_duplicate_rulecode_verification_context');
    const rawTools: unknown = Reflect.get(value, 'tools');
    if (!Array.isArray(rawTools)) throw new Error('invalid_rulecode_verification_tools');
    const tools: { rawToolName: string; canonicalKind: string }[] = [];
    for (const tool of rawTools) {
      if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) throw new Error('invalid_rulecode_verification_tool');
      const rawToolName: unknown = Reflect.get(tool, 'rawToolName');
      const canonicalKind: unknown = Reflect.get(tool, 'canonicalKind');
      if (typeof rawToolName !== 'string' || rawToolName.trim() === '' || typeof canonicalKind !== 'string'
        || !['read', 'search', 'write', 'execute', 'agent', 'other'].includes(canonicalKind)) throw new Error('invalid_rulecode_verification_tool');
      tools.push({ rawToolName, canonicalKind });
    }
    const rawOwnerCases: unknown = Reflect.get(value, 'ownerCases');
    if (rawOwnerCases !== undefined && !isOwnerVerificationCases(rawOwnerCases)) throw new Error('invalid_rulecode_verification_owner_cases');
    const ownerTrace = rawOwnerCases === undefined ? undefined : buildGoldenTraceFromArtificer({ cases: rawOwnerCases });
    if (ownerTrace !== undefined && !ownerTrace.ok) throw new Error('invalid_rulecode_verification_owner_cases');
    result = { scribe: { executionConditions: Reflect.get(value, 'executionConditions') }, tools,
      ...(ownerTrace?.ok ? { ownerCases: ownerTrace.trace.cases } : {}) };
  }
  return result;
}

export function isRuleCodeVerificationCoverage(value: unknown): value is RuleCodeVerificationCoverage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const isCount = (count: unknown): boolean => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  const strings = (items: unknown): boolean => Array.isArray(items) && items.every((item) => typeof item === 'string' && item.trim() !== '');
  if (!strings(Reflect.get(value, 'required')) || !strings(Reflect.get(value, 'unavailable'))) return false;
  if (!['executed', 'passed', 'failed'].every((key) => isCount(Reflect.get(value, key)))) return false;
  for (const key of ['historicalCoverage', 'contractCoverage']) {
    const counts: unknown = Reflect.get(value, key);
    if (typeof counts !== 'object' || counts === null || Array.isArray(counts)
      || !['executed', 'passed', 'failed', 'unavailable'].every((field) => isCount(Reflect.get(counts, field)))) return false;
    if (key === 'contractCoverage' && !isCount(Reflect.get(counts, 'required'))) return false;
  }
  const historical: unknown = Reflect.get(value, 'historical');
  const synthetic: unknown = Reflect.get(value, 'counterfactuals');
  if (!Array.isArray(historical) || !Array.isArray(synthetic)) return false;
  return historical.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    && typeof Reflect.get(entry, 'caseId') === 'string'
    && ['direct_replay', 'historical_evidence_only', 'invalid_input'].includes(Reflect.get(entry, 'qualification'))
    && strings(Reflect.get(entry, 'missingFacts')))
    && synthetic.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      && typeof Reflect.get(entry, 'caseId') === 'string' && Reflect.get(entry, 'source') === 'system_counterfactual'
      && Reflect.get(entry, 'contract') === 'DesignGateFact/v1');
}
