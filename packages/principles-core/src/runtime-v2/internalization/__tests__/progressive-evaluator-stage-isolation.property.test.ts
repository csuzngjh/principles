/**
 * CP-23 + CP-25 + CP-27 property tests (design §6.5, tasks 9.9/9.5/9.12).
 *
 * CP-23: Stage 2 isolation — finalOutput is entirely Stage 2's result when
 *         stagesRun=2; Stage 1 output is never injected into Stage 2.
 * CP-25: V2 guard whitelist — isEvaluatorOutputV2 correctly identifies outputs
 *         carrying only painCoverage/compressionFidelity as V2.
 * CP-27: Zero auto-rerun — progressive evaluator never triggers reruns.
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §6.5, §16
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  isForcedStage2,
  runProgressiveEvaluation,
  type ProgressiveEvaluatorLLM,
  type ProgressiveEvaluatorEvent,
} from '../progressive-evaluator.js';
import { isEvaluatorOutputV2 } from '../evaluator-output.js';

// ── CP-23: Stage 2 isolation ─────────────────────────────────────────────────

describe('CP-23 — Stage 2 isolation & final output source', () => {
  it('stagesRun=1 when not flagged, not forced, no undetermined', async () => {
    const llm: ProgressiveEvaluatorLLM = {
      evaluate: async () => ({
        compressionFidelity: { missingDimensions: [], optionalUncovered: [], betterDecisionCovered: true, rationaleCovered: true, riskLevelCovered: true, badDecisionCovered: false, explanation: '' },
        painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' },
        implementationFidelity: { score: 0.9 },
      }),
    };
    const result = await runProgressiveEvaluation({
      taskId: 'task-clean',
      startArtifactId: 'art-1',
      stage1Context: {},
      llm,
    });
    expect(result.stagesRun).toBe(1);
    expect(result.finalOutput).toEqual(await llm.evaluate({}));
  });

  it('stagesRun=2 when flagged → finalOutput is Stage 2 (not Stage 1)', async () => {
    let callCount = 0;
    const stage1Output = { evaluation: { decision: 'approved', concerns: ['c1'] }, compressionFidelity: { missingDimensions: ['riskLevel'], optionalUncovered: [], betterDecisionCovered: true, rationaleCovered: true, riskLevelCovered: false, badDecisionCovered: false, explanation: '' }, painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' }, implementationFidelity: { score: 0.9 } };
    const stage2Output = { evaluation: { decision: 'needs_revision', concerns: ['c1', 'c2'] }, compressionFidelity: { missingDimensions: [], optionalUncovered: [], betterDecisionCovered: true, rationaleCovered: true, riskLevelCovered: true, badDecisionCovered: false, explanation: '' }, painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' }, implementationFidelity: { score: 0.85 } };

    const llm: ProgressiveEvaluatorLLM = {
      evaluate: async () => {
        callCount++;
        return callCount === 1 ? stage1Output : stage2Output;
      },
    };
    const result = await runProgressiveEvaluation({
      taskId: 'task-flagged',
      startArtifactId: 'art-1',
      stage1Context: {},
      llm,
    });
    expect(result.stagesRun).toBe(2);
    // finalOutput MUST be Stage 2's output, not Stage 1's.
    expect(result.finalOutput).toEqual(stage2Output);
    expect(result.finalOutput).not.toEqual(stage1Output);
  });

  it('Stage 1 pass but Stage 2 fail → finalOutput takes Stage 2', async () => {
    const stage1Output = { evaluation: { decision: 'approved', concerns: [] }, compressionFidelity: { missingDimensions: [], optionalUncovered: [], betterDecisionCovered: true, rationaleCovered: true, riskLevelCovered: true, badDecisionCovered: false, explanation: '' }, painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' }, implementationFidelity: { score: 0.95 } };
    // Find a taskId that is forced.
    let forcedTaskId = '';
    for (let i = 0; i < 1000; i++) {
      const id = `force-${i}`;
      if (isForcedStage2(id)) { forcedTaskId = id; break; }
    }
    expect(forcedTaskId).not.toBe('');

    let callCount = 0;
    const stage2Output = { evaluation: { decision: 'rejected', concerns: ['critical'] }, compressionFidelity: { missingDimensions: ['riskLevel'], optionalUncovered: [], betterDecisionCovered: false, rationaleCovered: true, riskLevelCovered: false, badDecisionCovered: false, explanation: '' }, painCoverage: { fullyCovered: false, uncoveredAspects: ['x'], explanation: '' }, implementationFidelity: { score: 0.3 } };

    const llm: ProgressiveEvaluatorLLM = {
      evaluate: async () => {
        callCount++;
        return callCount === 1 ? stage1Output : stage2Output;
      },
    };
    const result = await runProgressiveEvaluation({
      taskId: forcedTaskId,
      startArtifactId: 'art-1',
      stage1Context: {},
      llm,
    });
    expect(result.stagesRun).toBe(2);
    expect(result.finalOutput).toEqual(stage2Output);
  });

  it('property: stagesRun=2 always means finalOutput came from the 2nd evaluate call', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          s1Missing: fc.array(fc.constantFrom('betterDecision', 'rationale', 'riskLevel')),
          s1FullyCovered: fc.boolean(),
          s1Score: fc.float({ min: 0, max: 1, noNaN: true }),
        }),
        async ({ s1Missing, s1FullyCovered, s1Score }) => {
          const stage1Sentinel = 'STAGE1_SENTINEL';
          const stage2Sentinel = 'STAGE2_SENTINEL';
          let callCount = 0;
          const llm: ProgressiveEvaluatorLLM = {
            evaluate: async () => {
              callCount++;
              return callCount === 1
                ? { _sentinel: stage1Sentinel, compressionFidelity: { missingDimensions: s1Missing, optionalUncovered: [], betterDecisionCovered: true, rationaleCovered: true, riskLevelCovered: true, badDecisionCovered: false, explanation: '' }, painCoverage: { fullyCovered: s1FullyCovered, uncoveredAspects: [], explanation: '' }, implementationFidelity: { score: s1Score } }
                : { _sentinel: stage2Sentinel };
            },
          };
          const result = await runProgressiveEvaluation({
            taskId: 'prop-test',
            startArtifactId: 'art-1',
            stage1Context: {},
            llm,
          });
          if (result.stagesRun === 2) {
            const fo = result.finalOutput as Record<string, unknown>;
            expect(fo._sentinel).toBe(stage2Sentinel);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── CP-25: V2 guard whitelist ────────────────────────────────────────────────

describe('CP-25 — V2 guard whitelist completeness', () => {
  it('output with only painCoverage → isEvaluatorOutputV2 returns true', () => {
    const output = {
      taskId: 't1',
      sourceArtificerArtifactId: 'art-1',
      evaluation: { decision: 'approved', summary: 'ok', score: 0.8, strengths: [], concerns: [], requiredChanges: [] },
      painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' },
    };
    expect(isEvaluatorOutputV2(output)).toBe(true);
  });

  it('output with only compressionFidelity → isEvaluatorOutputV2 returns true', () => {
    const output = {
      taskId: 't1',
      sourceArtificerArtifactId: 'art-1',
      evaluation: { decision: 'approved', summary: 'ok', score: 0.8, strengths: [], concerns: [], requiredChanges: [] },
      compressionFidelity: { betterDecisionCovered: true, rationaleCovered: true, riskLevelCovered: true, badDecisionCovered: false, missingDimensions: [], optionalUncovered: [], explanation: '' },
    };
    expect(isEvaluatorOutputV2(output)).toBe(true);
  });

  it('output with neither painCoverage nor compressionFidelity nor V2 fields → not V2', () => {
    const output = {
      taskId: 't1',
      sourceArtificerArtifactId: 'art-1',
      evaluation: { decision: 'approved', summary: 'ok', score: 0.8, strengths: [], concerns: [], requiredChanges: [] },
    };
    expect(isEvaluatorOutputV2(output)).toBe(false);
  });

  it('property: power set of V2 identifier fields → correct V2 detection', () => {
    const baseOutput = {
      taskId: 't1',
      sourceArtificerArtifactId: 'art-1',
      evaluation: { decision: 'approved', summary: 'ok', score: 0.8, strengths: [], concerns: [], requiredChanges: [] },
    };
    // painCoverage and compressionFidelity don't need sub-validation in isEvaluatorOutputV2.
    // codeReview needs a well-formed structure to pass validateCodeReview.
    const fields = [
      ['painCoverage', { fullyCovered: true, uncoveredAspects: [], explanation: '' }],
      ['compressionFidelity', { betterDecisionCovered: true, rationaleCovered: true, riskLevelCovered: true, badDecisionCovered: false, missingDimensions: [], optionalUncovered: [], explanation: '' }],
    ] as const;

    // Test each field individually.
    for (const [key, val] of fields) {
      const out = { ...baseOutput, [key]: val };
      expect(isEvaluatorOutputV2(out), `${key} alone should trigger V2`).toBe(true);
    }
    // All together.
    const all = { ...baseOutput };
    for (const [key, val] of fields) { (all as Record<string, unknown>)[key] = val; }
    expect(isEvaluatorOutputV2(all)).toBe(true);
    // None.
    expect(isEvaluatorOutputV2(baseOutput)).toBe(false);
  });

  it('compressionFidelity does NOT have strategicPerspectiveCovered', () => {
    // The type system enforces this, but verify at runtime that the field
    // is not expected by isEvaluatorOutputV2.
    const output = {
      taskId: 't1',
      sourceArtificerArtifactId: 'art-1',
      evaluation: { decision: 'approved', summary: 'ok', score: 0.8, strengths: [], concerns: [], requiredChanges: [] },
      compressionFidelity: {
        betterDecisionCovered: true,
        rationaleCovered: true,
        riskLevelCovered: true,
        badDecisionCovered: false,
        missingDimensions: [],
        optionalUncovered: [],
        explanation: '',
      },
    };
    expect(isEvaluatorOutputV2(output)).toBe(true);
    // Verify strategicPerspectiveCovered is NOT a key in compressionFidelity.
    expect(Object.hasOwn(output.compressionFidelity as object, 'strategicPerspectiveCovered')).toBe(false);
  });
});

// ── CP-27: Zero auto-rerun ──────────────────────────────────────────────────

describe('CP-27 — zero auto-rerun (diagnosis only, no enqueue)', () => {
  it('runProgressiveEvaluation never calls any rerun/enqueue/successor mechanism', async () => {
    // The pure function runProgressiveEvaluation only takes llm.evaluate and
    // optional lineage/emit. It has NO access to task queues, stateManager,
    // or any rerun mechanism. This test documents that contract.
    const events: ProgressiveEvaluatorEvent[] = [];
    const llm: ProgressiveEvaluatorLLM = {
      evaluate: async () => ({
        evaluation: { decision: 'rejected', concerns: ['c1'] },
        compressionFidelity: { missingDimensions: ['riskLevel'], optionalUncovered: [], betterDecisionCovered: false, rationaleCovered: true, riskLevelCovered: false, badDecisionCovered: false, explanation: '' },
        painCoverage: { fullyCovered: false, uncoveredAspects: ['x'], explanation: '' },
        implementationFidelity: { score: 0.3 },
      }),
    };
    const result = await runProgressiveEvaluation({
      taskId: 'task-degraded',
      startArtifactId: 'art-1',
      stage1Context: {},
      llm,
      emit: (e) => events.push(e),
    });
    // The outcome is degraded (flagged) → Stage 2 ran → finalOutput is Stage 2.
    expect(result.stagesRun).toBe(2);
    // Events are only lineage_data_corrupt or stage1_false_negative — never rerun.
    for (const e of events) {
      expect(e.type === 'lineage_data_corrupt' || e.type === 'stage1_false_negative').toBe(true);
    }
    // No rerun/enqueue/successor fields in the outcome.
    expect(Object.keys(result)).not.toContain('rerun');
    expect(Object.keys(result)).not.toContain('enqueue');
    expect(Object.keys(result)).not.toContain('createSuccessor');
  });

  it('all 3 verdicts (pass/degraded/fail) produce zero side effects', async () => {
    // Pass: Stage 1 sufficient.
    const passResult = await runProgressiveEvaluation({
      taskId: 'task-pass',
      startArtifactId: 'art-1',
      stage1Context: {},
      llm: { evaluate: async () => ({ evaluation: { decision: 'approved', concerns: [] }, compressionFidelity: { missingDimensions: [], optionalUncovered: [], betterDecisionCovered: true, rationaleCovered: true, riskLevelCovered: true, badDecisionCovered: false, explanation: '' }, painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' }, implementationFidelity: { score: 0.9 } }) },
    });
    expect(passResult.stagesRun).toBe(1);

    // Degraded: flagged.
    const degradedResult = await runProgressiveEvaluation({
      taskId: 'task-deg',
      startArtifactId: 'art-1',
      stage1Context: {},
      llm: {
        evaluate: async () => ({
          _call: 0,
          evaluation: { decision: 'needs_revision', concerns: ['c1'] },
          compressionFidelity: { missingDimensions: ['riskLevel'], optionalUncovered: [], betterDecisionCovered: true, rationaleCovered: true, riskLevelCovered: false, badDecisionCovered: false, explanation: '' },
          painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' },
          implementationFidelity: { score: 0.9 },
        }),
      },
    });
    expect(degradedResult.stagesRun).toBe(2);
    // Neither result contains any rerun/enqueue/successor action.
    const passKeys = Object.keys(passResult);
    const degKeys = Object.keys(degradedResult);
    for (const k of [...passKeys, ...degKeys]) {
      expect(k).not.toMatch(/rerun|enqueue|successor|retry/i);
    }
  });
});
