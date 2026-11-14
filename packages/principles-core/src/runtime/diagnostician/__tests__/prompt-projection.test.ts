/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §6.2 — prompt projection.
 */
import { describe, it, expect } from 'vitest';
import { projectStageBInput, projectStageCInput } from '../prompt-projection.js';
import { buildDiagnosticContextBudget } from '../diagnostic-context-budget.js';
import type { DiagRootCauseOutputV1 } from '../diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../diag-distiller-output.js';

function makeRootCause(overrides: Partial<DiagRootCauseOutputV1> = {}): DiagRootCauseOutputV1 {
  return {
    valid: true,
    taskId: 'diag_rootcause-task-1',
    artifactId: 'artifact-root',
    summary: 'The agent edited files without reading them first.',
    causalChain: [
      { why: 1, statement: 'The agent modified a module it had not read.', evidenceRefs: ['ev-1'] },
      { why: 2, statement: 'It relied on remembered structure.', evidenceRefs: ['ev-2'] },
    ],
    rootCause: 'Assumption: remembered architecture was treated as current truth',
    rootCauseCategory: 'Assumption',
    evidence: [
      { sourceRef: 'turn-1', note: 'Short note.' },
    ],
    confidence: 0.81,
    ...overrides,
  } as DiagRootCauseOutputV1;
}

const BUDGET_UNKNOWN = buildDiagnosticContextBudget({
  stage: 'B',
  modelInfo: null,
  systemPrompt: '',
});

const BUDGET_TINY = buildDiagnosticContextBudget({
  stage: 'C',
  modelInfo: { provider: 'p', model: 'm', contextWindowTokens: 2_048, maxOutputTokens: 512 },
  systemPrompt: '',
});

describe('projectStageBInput', () => {
  it('leaves a request that fits untouched and says so', () => {
    const input = { rootCauseArtifactId: 'artifact-root', rootCauseOutput: makeRootCause() };
    const result = projectStageBInput(input, BUDGET_UNKNOWN);
    expect(result.budgetExceeded).toBe(false);
    expect(result.value.rootCauseOutput).toEqual(input.rootCauseOutput);
    expect(result.manifest.truncated).toBe(false);
    expect(result.manifest.keyEvidencePreserved).toBe(true);
  });

  it('shortens a large evidence note while preserving the evidence reference', () => {
    const longNote = 'x'.repeat(40_000);
    const rootCauseOutput = makeRootCause({
      evidence: [{ sourceRef: 'turn-99', note: longNote }],
    });
    const result = projectStageBInput(
      { rootCauseArtifactId: 'artifact-root', rootCauseOutput },
      BUDGET_TINY,
    );

    expect(result.value.rootCauseOutput.evidence[0]?.sourceRef).toBe('turn-99');
    expect(result.value.rootCauseOutput.evidence[0]?.note.length).toBeLessThan(longNote.length);
    expect(result.manifest.dropped.some((entry) => entry.path === 'rootCauseOutput.evidence[0].note')).toBe(true);
    expect(result.manifest.keyEvidencePreserved).toBe(true);
    expect(result.budgetExceeded).toBe(false);
  });

  it('never drops P0 identifiers', () => {
    const rootCauseOutput = makeRootCause();
    const result = projectStageBInput(
      { rootCauseArtifactId: 'artifact-root', rootCauseOutput },
      BUDGET_TINY,
    );
    expect(result.value.rootCauseArtifactId).toBe('artifact-root');
    expect(result.value.rootCauseOutput.taskId).toBe('diag_rootcause-task-1');
    expect(result.value.rootCauseOutput.rootCause).toBe(rootCauseOutput.rootCause);
  });

  it('shortens long causal statements and records each cut', () => {
    const longStatement = 's'.repeat(5_000);
    const rootCauseOutput = makeRootCause({
      causalChain: [
        { why: 1, statement: longStatement, evidenceRefs: ['ev-1'] },
        { why: 2, statement: 'Short second step.', evidenceRefs: ['ev-2'] },
      ],
    });

    const result = projectStageBInput(
      { rootCauseArtifactId: 'artifact-root', rootCauseOutput },
      BUDGET_TINY,
    );

    const [first] = result.value.rootCauseOutput.causalChain;
    expect(first?.statement.length).toBeLessThan(longStatement.length);
    expect(first?.evidenceRefs).toEqual(['ev-1']);
    expect(result.value.rootCauseOutput.causalChain[1]?.statement).toBe('Short second step.');
    expect(result.manifest.dropped.some((entry) => entry.path === 'rootCauseOutput.causalChain[0].statement')).toBe(true);
  });

  it('refuses an irreducible payload instead of silently sending it', () => {
    // A root cause whose P0 field alone cannot fit the tiny window.
    const rootCauseOutput = makeRootCause({ summary: 'y'.repeat(40_000) });
    const result = projectStageBInput(
      { rootCauseArtifactId: 'artifact-root', rootCauseOutput },
      BUDGET_TINY,
    );
    expect(result.budgetExceeded).toBe(true);
    expect(result.manifest.overBudgetTokens).toBeGreaterThan(0);
  });
});

describe('projectStageCInput', () => {
  const distiller: DiagDistillerOutputV1 = {
    valid: true,
    taskId: 'diag_distiller-task-1',
    sourceRootCauseArtifactId: 'artifact-root',
    abstractedPrinciple: 'Understand the existing structure before changing it.',
    rationale: 'r'.repeat(8_000),
    groundedOnCorePrincipleIds: ['T-01'],
    scope: 'general',
    confidence: 0.75,
    ambiguityNotes: ['a'.repeat(2_000), 'b', 'c', 'd', 'e', 'f'],
  };

  it('bounds distiller prose and records each cut', () => {
    const trusted = {
      status: 'available' as const,
      principles: [
        { principleId: 'p-1', status: 'active', version: 3, text: 't'.repeat(4_000), contentDigest: 'digest-1' },
      ],
    };
    const result = projectStageCInput(
      {
        rootCauseArtifactId: 'artifact-root',
        rootCauseOutput: makeRootCause(),
        distillerArtifactId: 'artifact-distiller',
        distillerOutput: distiller,
        trustedContext: trusted,
      },
      BUDGET_TINY,
    );

    expect(result.value.distillerOutput.rationale.length).toBeLessThan(distiller.rationale.length);
    expect(result.value.distillerOutput.sourceRootCauseArtifactId).toBe('artifact-root');
    expect(result.value.distillerOutput.abstractedPrinciple).toBe(distiller.abstractedPrinciple);
    expect(result.manifest.dropped.some((entry) => entry.path === 'distillerOutput.rationale')).toBe(true);
    expect(result.manifest.dropped.some((entry) => entry.path === 'distillerOutput.ambiguityNotes')).toBe(true);
  });

  it('leaves a Stage C request that fits the budget untouched', () => {
    const generous = buildDiagnosticContextBudget({
      stage: 'C',
      modelInfo: { provider: 'p', model: 'm', contextWindowTokens: 200_000, maxOutputTokens: 4_000 },
      systemPrompt: '',
    });
    const input = {
      rootCauseArtifactId: 'artifact-root',
      rootCauseOutput: makeRootCause(),
      distillerArtifactId: 'artifact-distiller',
      distillerOutput: distiller,
      trustedContext: { status: 'available' as const, principles: [] },
    };

    const result = projectStageCInput(input, generous);

    expect(result.budgetExceeded).toBe(false);
    expect(result.manifest.truncated).toBe(false);
    expect(result.value.distillerOutput.rationale).toBe(distiller.rationale);
    expect(result.value.trustedContext).toEqual(input.trustedContext);
  });

  it('copies trusted context verbatim so its content digest stays valid', () => {
    const trusted = {
      status: 'available' as const,
      principles: [
        { principleId: 'p-1', status: 'active', version: 3, text: 't'.repeat(4_000), contentDigest: 'digest-1' },
      ],
    };
    const result = projectStageCInput(
      {
        rootCauseArtifactId: 'artifact-root',
        rootCauseOutput: makeRootCause(),
        distillerArtifactId: 'artifact-distiller',
        distillerOutput: distiller,
        trustedContext: trusted,
      },
      BUDGET_TINY,
    );
    expect(result.value.trustedContext).toEqual(trusted);
    expect(result.manifest.dropped.some((entry) => entry.path.startsWith('trustedContext'))).toBe(false);
  });
});
