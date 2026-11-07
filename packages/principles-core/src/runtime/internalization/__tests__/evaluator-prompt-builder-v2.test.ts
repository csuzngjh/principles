/**
 * EvaluatorPromptBuilder V2 tests (RuleHost MVP Activation, PRI-425).
 *
 * TDD Phase 5.1 RED — asserts behavior not yet implemented.
 *
 * Coverage (PRD Decision 7 Part A — Passive Review):
 *   - V2 artificer input (has implementationCode) → prompt includes code review
 *     three-dimension instruction (intentConsistency / scopePrecision / traceCoverage)
 *   - V2 input → scribe principle text is passed through to prompt input
 *   - V1 artificer input (no code) → prompt unchanged (backward compat)
 *   - short-circuit: instruction tells LLM to skip adversarial cases when
 *     passive review fails
 *
 * ERR checklist (EP-01): untrusted artificer artifact kept as `unknown` in the
 * prompt input; builder does not validate its shape (that is the validator's job).
 */
import { describe, it, expect } from 'vitest';
import { UNAVAILABLE_RULE_CONTEXT } from '../rule-context-v2.js';
import { validateGoldenTraceCase } from '../../golden-trace.js';
import {
  EvaluatorPromptBuilder,
  EVALUATOR_PROTOCOL_INSTRUCTION,
} from '../evaluator-prompt-builder.js';

const V1_ARTIFICER = {
  taskId: 'artificer-task-001',
  implementationPlan: {
    summary: 'Add input validation',
    targetSurface: 'src/ops/*.ts',
    changes: ['Add try-catch'],
    tests: ['Unit test for error handling'],
    rolloutNotes: ['Deploy behind feature flag'],
    confidence: 0.85,
  },
};

const V2_ARTIFICER = {
  ...V1_ARTIFICER,
  implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
  goldenTraceCases: [
    { caseId: 'negative-1', kind: 'negative', toolName: 'edit', params: { path: '/etc/x' }, expectedDecision: 'block' },
    { caseId: 'positive-1', kind: 'positive', toolName: 'read', params: { path: '/tmp/y' }, expectedDecision: 'allow' },
  ],
  affectedTools: ['edit'],
};

const SCRIBE_PRINCIPLE = {
  principleDraft: {
    title: 'Block writes to system directories',
    statement: 'Never allow edits to /etc without explicit approval.',
  },
  painReasonSummary: 'AI deleted a side-effect cleanup function during refactor.',
};

describe('EvaluatorPromptBuilder — V2 code review (PRI-425)', () => {
  const builder = new EvaluatorPromptBuilder();

  // ── V2 code-review instruction contract ──────────────────────────────────
  // PRI-891: five per-keyword its that ignored the buildPrompt output and
  // asserted the static constant were consolidated into this single pin.
  // The three-dimension OUTPUT schema itself is pinned behaviorally by
  // evaluator-output-v2.test.ts.

  it('instruction carries the PRI-425 code-review contract (dimensions, verdicts, example, short-circuit)', () => {
    // The instruction is input-independent (static constant); V2 inputs only
    // change what the model produces, not the instruction text.
    builder.buildPrompt({
      taskId: 'eval-task-001',
      contextHash: 'ctx-abc',
      sourceArtificerArtifactId: 'pi-art-artificer-001',
      artificerArtifact: V2_ARTIFICER,
      scribeArtifact: SCRIBE_PRINCIPLE,
    });
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('intentConsistency');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('scopePrecision');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('traceCoverage');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('precise');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('too_broad');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('too_narrow');
    // The example must include codeReview and adversarialCases so the model
    // cannot copy a V1 response.
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toMatch(/COMPLETE EXAMPLE OUTPUT[\s\S]*"codeReview"/);
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toMatch(/COMPLETE EXAMPLE OUTPUT[\s\S]*"adversarialCases"/);
    // Short-circuit: skip adversarial cases when passive review fails.
    expect(EVALUATOR_PROTOCOL_INSTRUCTION.toLowerCase()).toContain('adversarial');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION.toLowerCase()).toMatch(/skip|only.*pass|do not.*generat.*adversarial.*fail/);
  });

  // ── scribe principle text passed through ────────────────────────────────────

  it('V2 input → scribeArtifact passed through to prompt input', () => {
    const { promptInput } = builder.buildPrompt({
      taskId: 'eval-task-001',
      contextHash: 'ctx-abc',
      sourceArtificerArtifactId: 'pi-art-artificer-001',
      artificerArtifact: V2_ARTIFICER,
      scribeArtifact: SCRIBE_PRINCIPLE,
    });
    expect(promptInput.scribeArtifact).toEqual(SCRIBE_PRINCIPLE);
  });

  it('V2 input → artificerArtifact still passed through', () => {
    const { promptInput } = builder.buildPrompt({
      taskId: 'eval-task-001',
      contextHash: 'ctx-abc',
      sourceArtificerArtifactId: 'pi-art-artificer-001',
      artificerArtifact: V2_ARTIFICER,
      scribeArtifact: SCRIBE_PRINCIPLE,
    });
    expect(promptInput.artificerArtifact).toEqual(V2_ARTIFICER);
  });

  // ── V1 backward compatibility ────────────────────────────────────────────────

  it('V1 artificer input (no code) → buildPrompt succeeds without scribeArtifact', () => {
    const { promptInput } = builder.buildPrompt({
      taskId: 'eval-task-001',
      contextHash: 'ctx-abc',
      sourceArtificerArtifactId: 'pi-art-artificer-001',
      artificerArtifact: V1_ARTIFICER,
    });
    expect(promptInput.artificerArtifact).toEqual(V1_ARTIFICER);
    expect(promptInput.scribeArtifact).toBeUndefined();
  });
});


it('PRI-1041 enables declared DesignGate review even when model and historical cases omit the field', () => {
  const { systemPrompt } = new EvaluatorPromptBuilder().buildPrompt({
    taskId: 'evaluate-declaration', contextHash: 'fixture', sourceArtificerArtifactId: 'fixture-art', artificerArtifact: V2_ARTIFICER,
    scribeArtifact: { ...SCRIBE_PRINCIPLE, executionConditions: { version: 1, requiredFacts: [{ factKind: 'design_approval', required: true, textualBasis: 'Owner declaration' }] } },
  });
  expect(systemPrompt).toContain('DesignGateFact');
  expect(systemPrompt).toContain('historical_evidence_only');
  expect(systemPrompt).toContain('system_counterfactual');
});

describe('PRI-1041 immutable historical evidence prompt view', () => {
  const executionConditions = { version: 1, requiredFacts: [{ factKind: 'design_approval', required: true, textualBasis: 'Owner declaration' }] };
  const ownerCases = V2_ARTIFICER.goldenTraceCases.map((entry) => ({ ...entry,
    sourceRefs: { artifactId: 'immutable-owner-pack' }, ruleContext: UNAVAILABLE_RULE_CONTEXT }));
  const input = { taskId: 'evaluate-view', contextHash: 'fixture', sourceArtificerArtifactId: 'fixture-art',
    scribeArtifact: { executionConditions }, artificerArtifact: { ...V2_ARTIFICER, ownerGoldenTraceCases: ownerCases } };
  const builder = new EvaluatorPromptBuilder();

  it('moves missing-fact Owner labels out of both executable lists while preserving original source/schema and artifact bytes', () => {
    const original = JSON.stringify(input.artificerArtifact);
    const { promptInput, message, systemPrompt } = builder.buildPrompt(input);
    const view = JSON.parse(message).artificerArtifact;
    expect(view.goldenTraceCases).toEqual([]);
    expect(view.ownerGoldenTraceCases).toEqual([]);
    expect(view.historicalEvidenceOnlyCases).toHaveLength(4);
    const historical = view.historicalEvidenceOnlyCases.find((entry: { sourceField: string; caseId: string }) =>
      entry.sourceField === 'ownerGoldenTraceCases' && entry.caseId === 'negative-1');
    expect(historical.originalCase).toMatchObject({ caseId: 'negative-1', expectedDecision: 'block',
      sourceRefs: { artifactId: 'immutable-owner-pack' }, ruleContext: { facts: UNAVAILABLE_RULE_CONTEXT.facts } });
    expect(historical).toMatchObject({ qualification: 'historical_evidence_only', missingFacts: ['design_approval'] });
    expect(view.evaluatorHistoricalProvenance.qualificationBasis).toContain('system-owned ownerGoldenTraceCases');
    expect(view.evaluatorHistoricalProvenance[historical.sourceField]).toContain('system-owned Owner historical evidence');
    expect(systemPrompt).toContain('must not create requiredChanges to relabel');
    expect(promptInput.promptContractVersion).toBe('evaluator-output-v1.prompt.v13');
    expect(JSON.stringify(input.artificerArtifact)).toBe(original);
    expect(ownerCases.every((entry) => validateGoldenTraceCase(entry).valid)).toBe(true);
    expect(ownerCases[0]?.ruleContext.facts).not.toHaveProperty('designGate');
  });

  it('uses Owner qualification even if model golden cases invent a decisive fact', () => {
    const modelCases = ownerCases.map((entry) => ({ ...entry, ruleContext: { ...entry.ruleContext,
      facts: { ...entry.ruleContext.facts, designGate: { resolution: 'approved' } } } }));
    const view = JSON.parse(builder.buildPrompt({ ...input,
      artificerArtifact: { ...input.artificerArtifact, goldenTraceCases: modelCases } }).message).artificerArtifact;
    expect(view.goldenTraceCases).toEqual([]);
    expect(view.historicalEvidenceOnlyCases).toHaveLength(4);
  });

  it('keeps fact-complete Owner cases executable when model golden cases omit the fact', () => {
    const fact = { version: 1, sourceRef: 'owner-decision', revision: 1, requiresApproval: true,
      taskRef: 'task', specDigest: 'spec', scopeRef: 'scope', decisionTaskRef: 'task',
      decisionSpecDigest: 'spec', decisionScopeRef: 'scope', resolution: 'not_approved', revoked: false };
    const complete = ownerCases.map((entry) => ({ ...entry, ruleContext: { ...entry.ruleContext,
      facts: { ...entry.ruleContext.facts, designGate: fact } } }));
    const view = JSON.parse(builder.buildPrompt({ ...input,
      artificerArtifact: { ...input.artificerArtifact, ownerGoldenTraceCases: complete } }).message).artificerArtifact;
    expect(view.goldenTraceCases).toEqual(V2_ARTIFICER.goldenTraceCases);
    expect(view.ownerGoldenTraceCases).toHaveLength(2);
    expect(view.historicalEvidenceOnlyCases).toBeUndefined();
    expect(view.evaluatorHistoricalQualifications).toBeUndefined();
  });

  it('keeps unrelated no-fact and unsupported-fact principles on their existing executable path', () => {
    for (const requiredFacts of [[], [{ factKind: 'prior_read', required: true, textualBasis: 'read before write' }]]) {
      const view = JSON.parse(builder.buildPrompt({ ...input, scribeArtifact: { executionConditions: { version: 1, requiredFacts } } }).message).artificerArtifact;
      expect(view.goldenTraceCases).toEqual(V2_ARTIFICER.goldenTraceCases);
      expect(view.ownerGoldenTraceCases).toHaveLength(2);
      expect(view.historicalEvidenceOnlyCases ?? []).toEqual([]);
    }
  });

  it('does not hide invalid Owner facts or qualify model-only cases as immutable Owner evidence', () => {
    const invalidCases = ownerCases.map((entry) => ({ ...entry,
      ruleContext: { ...entry.ruleContext, facts: { ...entry.ruleContext.facts, designGate: { resolution: 'broken' } } } }));
    const artifact = { ...input.artificerArtifact, ownerGoldenTraceCases: invalidCases };
    expect(builder.buildPrompt({ ...input, artificerArtifact: artifact }).promptInput.artificerArtifact).toEqual(
      expect.objectContaining({ goldenTraceCases: artifact.goldenTraceCases }));
    const noStamp = builder.buildPrompt({ ...input, artificerArtifact: V2_ARTIFICER }).promptInput.artificerArtifact;
    expect(noStamp).toBe(V2_ARTIFICER);
  });

  it('deduplicates long exact histories across executable and moved evidence without increasing the 50000-character limit', () => {
    const history = { status: 'available', truncated: false,
      calls: [{ sequenceId: 1, toolName: 'read', canonicalKind: 'read', normalizedPath: '/workspace/source',
        paramsSummary: { content: 'x'.repeat(28000) }, outcome: 'success' }] };
    const cases = ownerCases.map((entry) => ({ ...entry, ruleContext: { ...entry.ruleContext, history } }));
    const artifact = { ...input.artificerArtifact, goldenTraceCases: cases, ownerGoldenTraceCases: cases };
    const original = JSON.stringify(artifact);
    const result = builder.buildPrompt({ ...input, artificerArtifact: artifact });
    const view = JSON.parse(result.message).artificerArtifact;
    expect(view.goldenTraceCases).toEqual([]);
    expect(view.historicalEvidenceOnlyCases).toHaveLength(4);
    expect(result.message.length).toBeLessThan(50000);
    expect(view.historicalEvidenceOnlyCases.filter((entry: { originalCase: { evaluatorDisplayNote?: string } }) =>
      entry.originalCase.evaluatorDisplayNote)).toHaveLength(3);
    expect(JSON.stringify(artifact)).toBe(original);
  });
});
