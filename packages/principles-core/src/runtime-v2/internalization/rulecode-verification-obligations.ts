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
      // PRI-1047 R8: the denied-readonly single probe is replaced by a
      // command-family probe table with HARDCODED expected decisions (never
      // computed from the classifier under test). Under not_approved:
      // positively-verified read-only commands must allow; mutations, git
      // global-option forms, output-file options, keyword-carrying-but-readonly
      // args/paths, pipes into scripts/mutations and inline code must NOT get
      // the exemption. A representative subset is also crossed with approved
      // (approved passes the gate face for every action class).
      if (tool.canonicalKind === 'execute') {
        const probes: readonly { id: string; command: string; expected: 'allow' | 'block'; crossApproved: boolean }[] = [
          { id: 'readonly-status', command: 'git status --short', expected: 'allow', crossApproved: true },
          { id: 'readonly-log-format', command: 'git log --format=oneline', expected: 'allow', crossApproved: false },
          { id: 'readonly-show-path', command: 'git show HEAD:src/form.ts', expected: 'allow', crossApproved: false },
          { id: 'readonly-grep-keyword', command: 'git grep touch', expected: 'allow', crossApproved: false },
          { id: 'readonly-cat', command: 'cat README.md', expected: 'allow', crossApproved: false },
          { id: 'readonly-globalopt-query', command: 'git -C . status', expected: 'allow', crossApproved: false },
          { id: 'mutate-remote-add', command: 'git remote add review https://example.com/repo.git', expected: 'block', crossApproved: true },
          { id: 'mutate-stash', command: 'git stash push', expected: 'block', crossApproved: false },
          { id: 'mutate-globalopt-commit', command: 'git -C . commit -m change', expected: 'block', crossApproved: false },
          { id: 'mutate-output-file', command: 'git show --output=review.txt HEAD', expected: 'block', crossApproved: false },
          { id: 'pipe-into-script', command: 'cat instructions.txt | sh', expected: 'block', crossApproved: true },
          { id: 'pipe-into-mutation', command: 'cat message.txt | git -C . commit -F -', expected: 'block', crossApproved: false },
          { id: 'inline-code-exec', command: 'node -e "process.stdout.write(1)"', expected: 'block', crossApproved: false },
          { id: 'sort-output-option', command: 'sort -o out.txt input.txt', expected: 'block', crossApproved: false },
          { id: 'uniq-output-operand', command: 'uniq input.txt out.txt', expected: 'block', crossApproved: false },
          { id: 'rg-pre-exec', command: 'rg --pre=./rewrite.sh pattern .', expected: 'block', crossApproved: false },
          { id: 'git-hash-object-write', command: 'git hash-object -w input.txt', expected: 'block', crossApproved: false },
          { id: 'git-reflog-delete', command: 'git reflog delete HEAD@{0}', expected: 'block', crossApproved: false },
          { id: 'git-branch-unset-upstream', command: 'git branch --unset-upstream', expected: 'block', crossApproved: false },
          { id: 'newline-hidden-mutation', command: 'cat README.md\ngit commit -m change', expected: 'block', crossApproved: false },
          { id: 'quoted-backtick-substitution', command: 'echo "`touch marker.txt`"', expected: 'block', crossApproved: false },
          { id: 'variable-expansion', command: 'cat "$INPUT_FILE"', expected: 'block', crossApproved: false },
          { id: 'environment-assignment-wrapper', command: 'PATH=/tmp/tools cat README.md', expected: 'block', crossApproved: false },
          { id: 'sudo-wrapper', command: 'sudo cat README.md', expected: 'block', crossApproved: false },
          { id: 'substitution-output-into-find', command: "find . \"$(printf '%s' '-delete')\"", expected: 'block', crossApproved: false },
          { id: 'reflog-output-file', command: 'git reflog show --output=/tmp/pd-probe', expected: 'block', crossApproved: false },
          { id: 'printf-n-write', command: "printf '%n' marker", expected: 'block', crossApproved: false },
          { id: 'read-write-redirection', command: 'cat <> /tmp/pd-probe', expected: 'block', crossApproved: false },
          { id: 'fd-read-write-redirection', command: 'cat 3<>/tmp/pd-probe', expected: 'block', crossApproved: false },
          { id: 'brace-expansion-find-action', command: 'find . {-delete,-print}', expected: 'block', crossApproved: false },
          { id: 'brace-expansion-rg-pre', command: 'rg {--pre=./rewrite.sh,pattern} .', expected: 'block', crossApproved: false },
          { id: 'git-config-pager', command: 'git -c core.pager=./rewrite.sh log', expected: 'block', crossApproved: false },
          { id: 'git-paginate', command: 'git --paginate log', expected: 'block', crossApproved: false },
          { id: 'git-diff-ext-diff', command: 'git diff --ext-diff HEAD', expected: 'block', crossApproved: false },
          { id: 'git-stash-ext-diff', command: 'git stash show --ext-diff', expected: 'block', crossApproved: false },
          { id: 'git-reflog-ext-diff', command: 'git reflog show --ext-diff', expected: 'block', crossApproved: false },
          { id: 'git-reflog-output', command: 'git reflog show --output=/tmp/pd-probe', expected: 'block', crossApproved: false },
          { id: 'find-quoted-operator-action', command: "find . -name '<' -exec touch /tmp/pd-probe ';'", expected: 'block', crossApproved: false },
          { id: 'rg-substitution-pre', command: "rg $(printf '%s' '--pre=./rewrite.sh') pattern .", expected: 'block', crossApproved: false },
          { id: 'readonly-quoted-operators', command: 'cat "a|rm -rf src"', expected: 'allow', crossApproved: false },
          { id: 'readonly-multiline-queries', command: 'cat README.md\ngit status', expected: 'allow', crossApproved: false },
        ];
        for (const probe of probes) {
          counterfactuals.push({ caseId: `system-contract:design_approval:${index}:probe:${probe.id}`, attackType: 'boundary', toolName: tool.rawToolName,
            params: { command: probe.command }, expectedDecision: probe.expected,
            rationale: `system_counterfactual; contract=DesignGateFact/v1; not_approved × ${probe.id}; expected ${probe.expected} (hardcoded, PRI-1047 R8 owner review); synthetic invocation, never historical approval.`,
            ruleContext: { ...UNAVAILABLE_RULE_CONTEXT, facts: { ...UNAVAILABLE_RULE_CONTEXT.facts, designGate: base } } });
          if (probe.crossApproved) {
            counterfactuals.push({ caseId: `system-contract:design_approval:${index}:probe-approved:${probe.id}`, attackType: 'boundary', toolName: tool.rawToolName,
              params: { command: probe.command }, expectedDecision: 'allow',
              rationale: `system_counterfactual; contract=DesignGateFact/v1; approved × ${probe.id}; approved passes the gate face for every action class (PRI-1047 R8).`,
              ruleContext: { ...UNAVAILABLE_RULE_CONTEXT, facts: { ...UNAVAILABLE_RULE_CONTEXT.facts, designGate: { ...base, resolution: 'approved' } } } });
          }
        }
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
