import { describe, it, expect } from 'vitest';
import type { PainFloodStage } from '../pain-flood-simulation.js';
import {
  computeFloodStatus,
  computeFloodTotals,
  formatContextBudgetSummary,
  recommendFloodNextIssue,
  boundedFloodEvidence,
  maxEvidencePreviewLength,
  safeStringify,
  FLOOD_SCENARIO_EXPECTATIONS,
} from '../pain-flood-simulation.js';

function makeStage(overrides: Partial<PainFloodStage> & { scenarioName: PainFloodStage['scenarioName']; status: PainFloodStage['status'] }): PainFloodStage {
  return {
    inputCount: 0,
    acceptedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    taskCount: 0,
    candidateCount: 0,
    ...overrides,
  };
}

describe('PainFloodSimulation pure helpers (PRI-208)', () => {
  describe('computeFloodTotals', () => {
    it('sums input, accepted, skipped, and failed counts across stages', () => {
      const stages: PainFloodStage[] = [
        makeStage({ scenarioName: 'identical_flood', status: 'passed', inputCount: 10, acceptedCount: 1, skippedCount: 9, candidateCount: 1, taskCount: 1 }),
        makeStage({ scenarioName: 'similar_flood', status: 'passed', inputCount: 5, acceptedCount: 5, skippedCount: 0, candidateCount: 5, taskCount: 5 }),
        makeStage({ scenarioName: 'duplicate_submission', status: 'passed', inputCount: 2, acceptedCount: 1, skippedCount: 1, candidateCount: 1, taskCount: 1 }),
      ];
      const totals = computeFloodTotals(stages);
      expect(totals.inputPainCount).toBe(17);
      expect(totals.acceptedPainCount).toBe(7);
      expect(totals.skippedDuplicateCount).toBe(10);
      expect(totals.failedCount).toBe(0);
      expect(totals.candidateCount).toBe(7);
      expect(totals.taskCount).toBe(7);
    });

    it('sums failedCount across stages', () => {
      const stages: PainFloodStage[] = [
        makeStage({ scenarioName: 'identical_flood', status: 'failed', inputCount: 10, acceptedCount: 1, skippedCount: 0, failedCount: 9, candidateCount: 1, taskCount: 1 }),
        makeStage({ scenarioName: 'similar_flood', status: 'passed', inputCount: 5, acceptedCount: 5, skippedCount: 0, failedCount: 0, candidateCount: 5, taskCount: 5 }),
      ];
      const totals = computeFloodTotals(stages);
      expect(totals.failedCount).toBe(9);
      expect(totals.skippedDuplicateCount).toBe(0);
    });

    it('unique signal failure produces zero skippedDuplicateCount', () => {
      const stages: PainFloodStage[] = [
        makeStage({ scenarioName: 'identical_flood', status: 'failed', inputCount: 3, acceptedCount: 0, skippedCount: 0, failedCount: 3, candidateCount: 0, taskCount: 0 }),
      ];
      const totals = computeFloodTotals(stages);
      expect(totals.skippedDuplicateCount).toBe(0);
      expect(totals.failedCount).toBe(3);
      expect(totals.acceptedPainCount).toBe(0);
    });

    it('skips stages with status "skipped"', () => {
      const stages: PainFloodStage[] = [
        makeStage({ scenarioName: 'identical_flood', status: 'passed', inputCount: 10, acceptedCount: 1 }),
        makeStage({ scenarioName: 'stress_test', status: 'skipped' }),
      ];
      const totals = computeFloodTotals(stages);
      expect(totals.inputPainCount).toBe(10);
      expect(totals.acceptedPainCount).toBe(1);
    });

    it('returns zeros for empty stages', () => {
      const totals = computeFloodTotals([]);
      expect(totals.inputPainCount).toBe(0);
      expect(totals.acceptedPainCount).toBe(0);
      expect(totals.skippedDuplicateCount).toBe(0);
      expect(totals.failedCount).toBe(0);
      expect(totals.candidateCount).toBe(0);
      expect(totals.taskCount).toBe(0);
    });
  });

  describe('computeFloodStatus', () => {
    it('returns healthy when all stages passed', () => {
      const stages: PainFloodStage[] = [
        makeStage({ scenarioName: 'identical_flood', status: 'passed' }),
        makeStage({ scenarioName: 'similar_flood', status: 'passed' }),
      ];
      expect(computeFloodStatus(stages)).toBe('healthy');
    });

    it('returns degraded when some failed', () => {
      const stages: PainFloodStage[] = [
        makeStage({ scenarioName: 'identical_flood', status: 'passed' }),
        makeStage({ scenarioName: 'similar_flood', status: 'failed' }),
      ];
      expect(computeFloodStatus(stages)).toBe('degraded');
    });

    it('returns error when no stages passed', () => {
      const stages: PainFloodStage[] = [
        makeStage({ scenarioName: 'identical_flood', status: 'failed' }),
        makeStage({ scenarioName: 'similar_flood', status: 'skipped' }),
      ];
      expect(computeFloodStatus(stages)).toBe('error');
    });
  });

  describe('formatContextBudgetSummary', () => {
    it('returns no evidence for zero length', () => {
      expect(formatContextBudgetSummary(0)).toBe('no evidence produced');
    });

    it('returns bounded for <= 100', () => {
      expect(formatContextBudgetSummary(50)).toBe('bounded (max 50 chars)');
    });

    it('returns moderate for <= 500', () => {
      expect(formatContextBudgetSummary(200)).toBe('moderate (max 200 chars)');
    });

    it('returns large for <= 2000', () => {
      expect(formatContextBudgetSummary(1500)).toBe('large (max 1500 chars)');
    });

    it('returns unbounded warning for > 2000', () => {
      expect(formatContextBudgetSummary(5000)).toBe('unbounded (max 5000 chars) — exceeds budget recommendation');
    });
  });

  describe('recommendFloodNextIssue', () => {
    it('returns undefined when no stages failed', () => {
      const stages: PainFloodStage[] = [makeStage({ scenarioName: 'identical_flood', status: 'passed' })];
      expect(recommendFloodNextIssue(stages)).toBeUndefined();
    });

    it('returns PRI-208 for identical_flood failure', () => {
      const stages: PainFloodStage[] = [makeStage({ scenarioName: 'identical_flood', status: 'failed' })];
      expect(recommendFloodNextIssue(stages)).toContain('PRI-208');
    });

    it('returns PRI-208 for duplicate_submission failure', () => {
      const stages: PainFloodStage[] = [makeStage({ scenarioName: 'duplicate_submission', status: 'failed' })];
      expect(recommendFloodNextIssue(stages)).toContain('PRI-208');
    });

    it('returns PRI-208 for stress_test failure', () => {
      const stages: PainFloodStage[] = [makeStage({ scenarioName: 'stress_test', status: 'failed' })];
      expect(recommendFloodNextIssue(stages)).toContain('PRI-208');
    });
  });

  describe('maxEvidencePreviewLength', () => {
    it('returns max JSON length across stages', () => {
      const stages: PainFloodStage[] = [
        makeStage({ scenarioName: 'identical_flood', status: 'passed', evidence: { a: 'short' } }),
        makeStage({ scenarioName: 'similar_flood', status: 'passed', evidence: { long: 'x'.repeat(200) } }),
      ];
      const max = maxEvidencePreviewLength(stages);
      expect(max).toBeGreaterThan(0);
      // The second stage's evidence should be longer
      const firstLen = JSON.stringify({ a: 'short' }).length;
      const secondLen = JSON.stringify({ long: 'x'.repeat(200) }).length;
      expect(max).toBe(secondLen);
      expect(max).toBeGreaterThan(firstLen);
    });

    it('returns 0 when no evidence', () => {
      expect(maxEvidencePreviewLength([])).toBe(0);
    });
  });

  describe('boundedFloodEvidence', () => {
    it('returns evidence as-is when within budget', () => {
      const evidence = { key: 'value', count: 42 };
      expect(boundedFloodEvidence(evidence)).toEqual(evidence);
    });

    it('truncates evidence with super-long keys', () => {
      const evidence: Record<string, unknown> = {};
      evidence['x'.repeat(1900)] = 'value';
      const json = JSON.stringify(boundedFloodEvidence(evidence));
      expect(json.length).toBeLessThanOrEqual(2000);
    });

    it('handles circular references safely', () => {
      const evidence: Record<string, unknown> = {};
      evidence.self = evidence;
      const json = JSON.stringify(boundedFloodEvidence(evidence));
      expect(json.length).toBeLessThanOrEqual(2000);
    });

    it('handles BigInt values', () => {
      const evidence = { bigNum: BigInt(9007199254740991) };
      const json = JSON.stringify(boundedFloodEvidence(evidence));
      expect(json).toContain('9007199254740991n');
    });
  });

  describe('safeStringify', () => {
    it('handles BigInt', () => {
      expect(safeStringify(BigInt(123))).toBe('123n');
    });

    it('handles circular references', () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      expect(safeStringify(obj)).toBe('[unserializable]');
    });

    it('handles undefined', () => {
      expect(safeStringify(undefined)).toBe('undefined');
    });

    it('handles null', () => {
      expect(safeStringify(null)).toBe('null');
    });

    it('handles Object.create(null)', () => {
      const obj = Object.create(null) as Record<string, unknown>;
      obj.key = 'value';
      const result = safeStringify(obj);
      expect(result).toContain('key');
      expect(result).toContain('value');
    });
  });

  describe('FLOOD_SCENARIO_EXPECTATIONS', () => {
    it('has expectations for all 5 scenario names', () => {
      const names = Object.keys(FLOOD_SCENARIO_EXPECTATIONS);
      expect(names).toEqual(['identical_flood', 'similar_flood', 'duplicate_submission', 'tool_failure_flood', 'stress_test']);
    });

    it('identical_flood expects at most 1 task total (maxTaskCount=1)', () => {
      expect(FLOOD_SCENARIO_EXPECTATIONS.identical_flood.maxTaskCount).toBe(1);
      expect(FLOOD_SCENARIO_EXPECTATIONS.identical_flood.description).toContain('identical');
    });

    it('duplicate_submission expects at most 1 task total (maxTaskCount=1)', () => {
      expect(FLOOD_SCENARIO_EXPECTATIONS.duplicate_submission.maxTaskCount).toBe(1);
    });

    it('tool_failure_flood expects at most 1 task total (maxTaskCount=1)', () => {
      expect(FLOOD_SCENARIO_EXPECTATIONS.tool_failure_flood.maxTaskCount).toBe(1);
    });

    it('similar_flood has no absolute cap (maxTaskCount undefined)', () => {
      expect(FLOOD_SCENARIO_EXPECTATIONS.similar_flood.maxTaskCount).toBeUndefined();
    });

    it('stress_test has no absolute cap (maxTaskCount undefined)', () => {
      expect(FLOOD_SCENARIO_EXPECTATIONS.stress_test.maxTaskCount).toBeUndefined();
    });

    it('all expectations have a description', () => {
      for (const [, exp] of Object.entries(FLOOD_SCENARIO_EXPECTATIONS)) {
        expect(exp.description.length).toBeGreaterThan(0);
        expect(exp.maxTaskRatio).toBeGreaterThan(0);
      }
    });
  });
});