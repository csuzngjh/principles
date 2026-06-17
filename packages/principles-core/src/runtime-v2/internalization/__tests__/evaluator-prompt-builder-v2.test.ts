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

  // ── V2 input triggers code review instruction ──────────────────────────────

  it('V2 artificer input → instruction mentions intentConsistency', () => {
    builder.buildPrompt({
      taskId: 'eval-task-001',
      contextHash: 'ctx-abc',
      sourceArtificerArtifactId: 'pi-art-artificer-001',
      artificerArtifact: V2_ARTIFICER,
      scribeArtifact: SCRIBE_PRINCIPLE,
    });
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('intentConsistency');
  });

  it('V2 artificer input → instruction mentions scopePrecision', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('scopePrecision');
  });

  it('V2 artificer input → instruction mentions traceCoverage', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('traceCoverage');
  });

  it('V2 instruction includes the three scopePrecision verdicts', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('precise');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('too_broad');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('too_narrow');
  });

  // ── short-circuit: skip adversarial when passive review fails ──────────────

  it('instruction tells LLM to skip adversarial cases when passive review fails', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION.toLowerCase()).toContain('adversarial');
    // The instruction must communicate the short-circuit rule.
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

  it('V1 input → instruction still works (code review section is conditional on V2 fields)', () => {
    // The instruction can mention code review unconditionally; the LLM only
    // produces codeReview when the artificer artifact carries implementationCode.
    // This test just ensures V1 path doesn't crash.
    const result = builder.buildPrompt({
      taskId: 'eval-task-001',
      contextHash: 'ctx-abc',
      sourceArtificerArtifactId: 'pi-art-artificer-001',
      artificerArtifact: V1_ARTIFICER,
    });
    expect(result.message).toContain('eval-task-001');
  });
});
