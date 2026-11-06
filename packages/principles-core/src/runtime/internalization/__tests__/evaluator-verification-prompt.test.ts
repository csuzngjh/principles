import { describe, expect, it } from 'vitest';
import { EvaluatorPromptBuilder } from '../evaluator-prompt-builder.js';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { deriveRuleCodeVerification } from '../rulecode-verification-obligations.js';
import { UNAVAILABLE_RULE_CONTEXT } from '../rule-context-v2.js';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import type { PDRuntimeAdapter, StartRunInput } from '../../runtime-protocol.js';

const tools = [{ rawToolName: 'Bash', canonicalKind: 'execute' as const }, { rawToolName: 'Write', canonicalKind: 'write' as const }];
const scribe = { executionConditions: { version: 1, requiredFacts: [{ factKind: 'design_approval', required: true, textualBasis: 'Owner approval before governed changes' }] } };
const ownerCases = [
  { caseId: 'owner-negative', kind: 'negative' as const, toolName: 'Bash', params: { command: 'git commit -m owner' }, expectedDecision: 'block' as const, ruleContext: UNAVAILABLE_RULE_CONTEXT },
  { caseId: 'owner-positive', kind: 'positive' as const, toolName: 'Bash', params: { command: 'git status' }, expectedDecision: 'allow' as const, ruleContext: UNAVAILABLE_RULE_CONTEXT },
];
const artifact = { implementationCode: 'function evaluate() { return {decision:"allow",matched:false,reason:"fixture"}; }',
  requiresContextVersion: 2, goldenTraceCases: ownerCases, ownerGoldenTraceCases: ownerCases, affectedTools: ['Bash'] };
const input = { taskId: 'evaluate-1047', contextHash: 'current-context', sourceArtificerArtifactId: 'current-artificer',
  artificerArtifact: artifact, scribeArtifact: scribe, hostToolKinds: tools };

function expandRuleContext(plan: {
  ruleContextBase: { facts: Record<string, unknown> };
  designGateBase: Record<string, unknown>;
  ruleContexts: Record<string, { facts: Record<string, unknown> }>;
}, ref: string) {
  const overrides = plan.ruleContexts[ref];
  if (overrides === undefined) throw new Error('missing context reference');
  const facts = { ...plan.ruleContextBase.facts, ...overrides.facts };
  if (Object.hasOwn(overrides.facts, 'designGate')) {
    const gate = overrides.facts.designGate;
    if (typeof gate !== 'object' || gate === null) throw new Error('invalid gate overrides');
    facts.designGate = { ...plan.designGateBase, ...gate };
  }
  return { ...plan.ruleContextBase, ...overrides, facts };
}

function expandHistoryCall(view: {
  evaluatorHistoryCalls: Record<string, readonly unknown[]>;
  evaluatorHistoryCallColumns: Record<string, readonly string[]>;
}, call: { evaluatorHistoryCallRef?: string }) {
  if (call.evaluatorHistoryCallRef === undefined) return call;
  const row = view.evaluatorHistoryCalls[call.evaluatorHistoryCallRef];
  if (row === undefined) throw new Error('missing historical call');
  const [shape, ...values] = row;
  if (typeof shape !== 'string' || view.evaluatorHistoryCallColumns[shape] === undefined) throw new Error('missing historical call columns');
  return Object.fromEntries(view.evaluatorHistoryCallColumns[shape].map((field, index) => [field, values[index]]));
}

describe('Evaluator receives the existing system verification obligations before judgment', () => {
  it('exposes every concrete system counterfactual even when all Owner cases are evidence-only, without claiming execution', () => {
    const original = JSON.stringify(artifact);
    const { message, systemPrompt } = new EvaluatorPromptBuilder().buildPrompt(input);
    const prompt = JSON.parse(message);
    expect(prompt.artificerArtifact.goldenTraceCases).toEqual([]);
    expect(prompt.artificerArtifact.ownerGoldenTraceCases).toEqual([]);
    expect(prompt.artificerArtifact.historicalEvidenceOnlyCases).toHaveLength(4);
    const plan = prompt.ruleCodeVerification;
    expect(plan).toBeDefined();
    expect(plan).toMatchObject({ executionStatus: 'not_executed', source: 'system_counterfactual',
      sourceArtificerArtifactId: input.sourceArtificerArtifactId, contextHash: input.contextHash,
      verificationCoverage: { required: ['design_approval'], executed: 0, passed: 0, failed: 0,
        historicalCoverage: { executed: 0, passed: 0, failed: 0, unavailable: 2 } } });
    const derived = deriveRuleCodeVerification(scribe, ownerCases, tools);
    expect(plan.counterfactualColumns).toEqual(['caseIdSuffix', 'actionRef', 'ruleContextRef', 'expectedDecision']);
    expect(plan.counterfactuals.map(([suffix, actionRef, ruleContextRef, expectedDecision]: [string, string, string, string]) =>
      ({ caseId: plan.caseIdPrefix + suffix, ...plan.actions[actionRef], expectedDecision, ruleContext: expandRuleContext(plan, ruleContextRef) })))
      .toEqual(derived.counterfactuals.map(({ caseId, toolName, params, expectedDecision, ruleContext }) =>
      ({ caseId, toolName, params, expectedDecision, ruleContext })));
    expect(plan.verificationCoverage.contractCoverage).toEqual({ required: derived.counterfactuals.length,
      executed: 0, passed: 0, failed: 0, unavailable: derived.counterfactuals.length });
    expect(systemPrompt).toContain('do not demand duplicate model-authored golden cases');
    expect(systemPrompt).toContain('not execution results');
    expect(JSON.stringify(artifact)).toBe(original);
  });

  it('keeps the concrete plan inside the existing prompt limit when historical traces repeat', () => {
    const history = { status: 'available' as const, truncated: false, calls: [{ sequenceId: 1, toolName: 'Read', canonicalKind: 'read' as const,
      normalizedPath: '/workspace/source', paramsSummary: { content: 'x'.repeat(28000) }, outcome: 'success' as const }] };
    const cases = ownerCases.map((entry) => ({ ...entry, ruleContext: { ...entry.ruleContext, history } }));
    const result = new EvaluatorPromptBuilder().buildPrompt({ ...input,
      artificerArtifact: { ...artifact, goldenTraceCases: cases, ownerGoldenTraceCases: cases } });
    expect(result.message.length).toBeLessThan(50000);
    expect(JSON.parse(result.message).ruleCodeVerification.counterfactuals.length).toBeGreaterThan(0);
  });

  it('does not promote model-authored verification claims to system evidence', () => {
    const result = new EvaluatorPromptBuilder().buildPrompt({ ...input,
      artificerArtifact: { ...artifact, ruleCodeVerification: { executionStatus: 'passed', passed: 999 } } });
    expect(JSON.parse(result.message).ruleCodeVerification).toMatchObject({ executionStatus: 'not_executed', verificationCoverage: { passed: 0 } });
  });

  it('losslessly shares overlapping historical calls while retaining full formation and repair context under the cap', () => {
    const shared = { sequenceId: 1, toolName: 'Read', canonicalKind: 'read', normalizedPath: '/source',
      paramsSummary: { content: 'x'.repeat(22000) }, outcome: 'success' };
    const cases = ownerCases.map((entry, index) => ({ ...entry, ruleContext: { ...entry.ruleContext,
      history: { status: 'available', truncated: false, calls: [shared, { ...shared, sequenceId: 2, normalizedPath: `/unique-${index}`, paramsSummary: {} }] } } }));
    const original = JSON.stringify(cases);
    const result = new EvaluatorPromptBuilder().buildPrompt({ ...input, artificerArtifact: { ...artifact, goldenTraceCases: cases, ownerGoldenTraceCases: cases },
      previousEvaluation: { decision: 'needs_revision', score: 0.8, concerns: ['x'.repeat(4300)],
        requirements: [{ id: 'req-1', statement: 'x'.repeat(1350) }], repairIteration: 1 } });
    const prompt = JSON.parse(result.message);
    for (const entry of prompt.artificerArtifact.historicalEvidenceOnlyCases.filter((row: { sourceField: string }) => row.sourceField === 'goldenTraceCases')) {
      const expected = cases.find(row => row.caseId === entry.caseId);
      expect(entry.originalCase.ruleContext.history.calls.map((call: { evaluatorHistoryCallRef?: string }) =>
        expandHistoryCall(prompt.artificerArtifact, call))).toEqual(expected?.ruleContext.history.calls);
      expect(entry.originalCase.ruleContext.history.truncated).toBe(false);
    }
    expect(result.message.length).toBeLessThan(50000);
    expect(result.systemPrompt).toContain('Expand each reference in place and keep array order');
    expect(JSON.stringify(cases)).toBe(original);
  });

  it('marks normalizedPath identical to paramsSummary.command losslessly (R9: real repair artifact exceeded the cap)', () => {
    const command = 'git diff --check; git add apps/web/src/app/result apps/web/src/app/store && npm test -- apps/web';
    // Distinct histories per case (sequenceId varies) so the whole-history
    // dedup stage keeps every case's calls — this test isolates the marker.
    const cases = ownerCases.map((entry, index) => {
      const duplicated = { sequenceId: index * 2 + 1, toolName: 'Bash', canonicalKind: 'execute',
        normalizedPath: command, paramsSummary: { command }, outcome: 'success' };
      const distinct = { sequenceId: index * 2 + 2, toolName: 'Read', canonicalKind: 'read',
        normalizedPath: '/different/path', paramsSummary: { command }, outcome: 'success' };
      return { ...entry, ruleContext: { ...entry.ruleContext,
        history: { status: 'available', truncated: false, calls: [duplicated, distinct] } } };
    });
    const original = JSON.stringify(cases);
    const result = new EvaluatorPromptBuilder().buildPrompt({ ...input,
      artificerArtifact: { ...artifact, goldenTraceCases: cases, ownerGoldenTraceCases: cases } });
    const prompt = JSON.parse(result.message);
    const expandMarked = (call: Record<string, unknown>): Record<string, unknown> => {
      const expanded: Record<string, unknown> = 'evaluatorHistoryCallRef' in call
        ? expandHistoryCall(prompt.artificerArtifact, call)
        : call;
      if (expanded.normalizedPathSameAsCommand === true) {
        const restored = { ...expanded };
        delete restored.normalizedPathSameAsCommand;
        const params = restored.paramsSummary as { command: string };
        restored.normalizedPath = params.command;
        return restored;
      }
      return expanded;
    };
    expect(result.systemPrompt).toContain('normalizedPathSameAsCommand');
    for (const entry of prompt.artificerArtifact.historicalEvidenceOnlyCases.filter((row: { sourceField: string }) => row.sourceField === 'goldenTraceCases')) {
      const expected = cases.find(row => row.caseId === entry.caseId);
      expect(entry.originalCase.ruleContext.history.calls.map(expandMarked)).toEqual(expected?.ruleContext.history.calls);
    }
    // Each row carries the command at most once — the marker removed the
    // normalizedPath copy (without it, bash rows contain the string twice).
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rowStrings = Object.values(prompt.artificerArtifact.evaluatorHistoryCalls as Record<string, unknown[]>)
      .map((row) => JSON.stringify(row));
    expect(rowStrings.every((row) => (row.match(new RegExp(escaped, 'g')) ?? []).length <= 1)).toBe(true);
    expect(JSON.stringify(cases)).toBe(original);
  });
});

describe('EvaluatorRunner model-request consumer', () => {
  async function invoke(scribeArtifact: unknown, artificerArtifact: unknown = artifact) {
    const requests: StartRunInput[] = [];
    const adapter: PDRuntimeAdapter = {
      kind: () => 'test-double', getCapabilities: async () => { throw new Error('unused'); }, healthCheck: async () => { throw new Error('unused'); },
      startRun: async (request) => { requests.push(request); return { runId: 'prompt-run', runtimeKind: 'test-double', startedAt: '2026-10-27T00:00:00.000Z' }; },
      pollRun: async () => { throw new Error('unused'); }, fetchOutput: async () => { throw new Error('unused'); },
      fetchArtifacts: async () => [], cancelRun: async () => undefined,
    };
    const events: unknown[] = [];
    const emitter = new StoreEventEmitter();
    emitter.onTelemetry((event) => events.push(event.payload));
    const runner = new EvaluatorRunner({ stateManager: new RuntimeStateManager({ workspaceDir: '.tmp/evaluator-unused-state' }),
      runtimeAdapter: adapter, eventEmitter: emitter, artifactStore: { getArtifactById: async () => null, listBySourceTaskId: async () => [],
        createArtifact: async () => { throw new Error('unused'); }, upsertArtifact: async () => { throw new Error('unused'); },
        listLineage: async () => [], updateValidationStatus: async () => { throw new Error('unused'); } },
      validator: new DefaultEvaluatorValidator() }, { owner: 'test', runtimeKind: 'test-double',
      hostSemanticContext: { hostKinds: ['codex'], tools } });
    const promise = runner.invokeRuntime(input.taskId, { contextHash: input.contextHash,
      sourceArtificerArtifactId: input.sourceArtificerArtifactId, sourceScribeArtifactId: 'current-scribe',
      artificerArtifact: JSON.stringify(artificerArtifact), scribeArtifact: JSON.stringify(scribeArtifact) });
    return { promise, requests, events };
  }

  it('sends the real builder projection to startRun with current artifact identity and host mappings', async () => {
    const run = await invoke(scribe);
    await run.promise;
    expect(run.requests).toHaveLength(1);
    const prompt = JSON.parse(String(run.requests[0]?.inputPayload));
    expect(prompt.ruleCodeVerification).toMatchObject({ sourceArtificerArtifactId: input.sourceArtificerArtifactId,
      contextHash: input.contextHash, executionStatus: 'not_executed' });
    expect(prompt.ruleCodeVerification.counterfactuals.some(([_id, actionRef, _context, expected]: [string, string, string, string]) =>
      prompt.ruleCodeVerification.actions[actionRef].params.command === 'git show --output=review.txt HEAD' && expected === 'block')).toBe(true);
  });

  it.each([
    ['unsupported', { executionConditions: { version: 1, requiredFacts: [{ factKind: 'other_fact', required: true, textualBasis: 'unsupported fact' }] } }, artifact, 'unsupported_required_fact:other_fact'],
    ['corrupted', { executionConditions: { version: 1, requiredFacts: 'broken' } }, artifact, 'execution_conditions_corrupted'],
    ['malformed historical fact', scribe, { ...artifact, ownerGoldenTraceCases: ownerCases.map((entry) => ({ ...entry,
      ruleContext: { ...entry.ruleContext, facts: { ...entry.ruleContext.facts, designGate: { resolution: 'broken' } } } })) }, 'historical_fact_invalid'],
  ].map(([name, source, candidate, reason]) => ({ name, source, candidate, reason })))('refuses $name before the model request instead of presenting a successful plan', async ({ source, candidate, reason }) => {
    const run = await invoke(source, candidate);
    await expect(run.promise).rejects.toThrow(String(reason));
    expect(run.requests).toEqual([]);
    expect(run.events).toContainEqual(expect.objectContaining({ reason: 'required_fact_verification_unavailable', passed: 0, executed: 0 }));
  });
});
