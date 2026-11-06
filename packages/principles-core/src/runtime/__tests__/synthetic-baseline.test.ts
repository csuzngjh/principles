import { describe, it, expect } from 'vitest';
import type { SyntheticBaselineStage } from '../synthetic-baseline.js';
import {
  computeOverallStatus,
  boundedEvidence,
  safeStringify,
  truncateReason,
  recommendNextIssue,
  makeDeterministicDiagnosticianOutput,
} from '../synthetic-baseline.js';

function makeStage(status: SyntheticBaselineStage['status'], name = 'pain_intake'): SyntheticBaselineStage {
  return { name: name as SyntheticBaselineStage['name'], status };
}

describe('Synthetic Baseline pure helpers (PRI-206)', () => {
  describe('computeOverallStatus', () => {
    it('returns passed when all stages passed', () => {
      const stages = [
        makeStage('passed', 'pain_intake'),
        makeStage('passed', 'diagnostician_task_created'),
        makeStage('passed', 'candidate_created'),
      ];
      expect(computeOverallStatus(stages)).toBe('passed');
    });

    it('returns failed when all stages failed', () => {
      const stages = [
        makeStage('failed', 'pain_intake'),
        makeStage('failed', 'diagnostician_task_created'),
        makeStage('failed', 'candidate_created'),
      ];
      expect(computeOverallStatus(stages)).toBe('failed');
    });

    it('returns degraded when some passed and some failed', () => {
      const stages = [
        makeStage('passed', 'pain_intake'),
        makeStage('failed', 'diagnostician_task_created'),
      ];
      expect(computeOverallStatus(stages)).toBe('degraded');
    });

    it('returns degraded when passed, failed, and skipped are mixed', () => {
      const stages = [
        makeStage('passed', 'pain_intake'),
        makeStage('failed', 'diagnostician_task_created'),
        makeStage('skipped', 'candidate_created'),
      ];
      expect(computeOverallStatus(stages)).toBe('degraded');
    });

    it('returns degraded when all stages are skipped', () => {
      const stages = [
        makeStage('skipped', 'pain_intake'),
        makeStage('skipped', 'diagnostician_task_created'),
      ];
      expect(computeOverallStatus(stages)).toBe('degraded');
    });
  });

  describe('boundedEvidence', () => {
    it('returns evidence as-is when within budget', () => {
      const evidence = { key: 'value', count: 42 };
      const result = boundedEvidence(evidence);
      expect(result).toEqual(evidence);
    });

    it('truncates evidence with super-long keys', () => {
      const longKey = 'x'.repeat(1900);
      const evidence: Record<string, unknown> = {};
      evidence[longKey] = 'value';
      const result = boundedEvidence(evidence);
      const json = JSON.stringify(result);
      expect(json.length).toBeLessThanOrEqual(2000);
    });

    it('handles circular references safely', () => {
      const evidence: Record<string, unknown> = {};
      evidence.self = evidence;
      const result = boundedEvidence(evidence);
      const json = JSON.stringify(result);
      expect(json.length).toBeLessThanOrEqual(2000);
    });

    it('handles BigInt values', () => {
      const evidence: Record<string, unknown> = { bigNum: BigInt(9007199254740991) };
      const result = boundedEvidence(evidence);
      const json = JSON.stringify(result);
      expect(json.length).toBeLessThanOrEqual(2000);
      expect(json).toContain('9007199254740991n');
    });

    it('truncates when many fields exceed budget', () => {
      const evidence: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        evidence[`field_${String(i).padStart(3, '0')}`] = 'x'.repeat(50);
      }
      const result = boundedEvidence(evidence);
      const json = JSON.stringify(result);
      expect(json.length).toBeLessThanOrEqual(2000);
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
      const obj = Object.create(null);
      obj.key = 'value';
      const result = safeStringify(obj);
      expect(result).toContain('key');
      expect(result).toContain('value');
    });

    it('handles normal objects', () => {
      expect(safeStringify({ a: 1 })).toBe('{"a":1}');
    });
  });

  describe('truncateReason', () => {
    it('returns short strings unchanged', () => {
      expect(truncateReason('short')).toBe('short');
    });

    it('truncates long strings with ellipsis', () => {
      const long = 'x'.repeat(600);
      const result = truncateReason(long);
      expect(result.length).toBeLessThanOrEqual(500);
      expect(result.endsWith('...')).toBe(true);
    });
  });

  describe('recommendNextIssue', () => {
    it('returns undefined when no stages failed', () => {
      const stages = [makeStage('passed', 'pain_intake')];
      expect(recommendNextIssue(stages)).toBeUndefined();
    });

    it('returns PRI-207 for failed pain_intake', () => {
      const stages = [makeStage('failed', 'pain_intake')];
      expect(recommendNextIssue(stages)).toContain('PRI-207');
    });

    it('returns PRI-209 for failed ledger_consistent', () => {
      const stages = [
        makeStage('passed', 'pain_intake'),
        makeStage('failed', 'ledger_consistent'),
      ];
      expect(recommendNextIssue(stages)).toContain('PRI-209');
    });

    it('returns PRI-208 for failed canary_health', () => {
      const stages = [makeStage('failed', 'canary_health')];
      expect(recommendNextIssue(stages)).toContain('PRI-208');
    });
  });

  describe('makeDeterministicDiagnosticianOutput', () => {
    it('produces valid DiagnosticianOutputV1', () => {
      const output = makeDeterministicDiagnosticianOutput('test-pain-123');
      expect(output.valid).toBe(true);
      expect(output.confidence).toBe(0.95);
      expect(output.diagnosisId).toBe('synth-diag-test-pain-123');
      const firstRec = output.recommendations.find(() => true);
      expect(firstRec).toBeDefined();
      expect(firstRec?.kind).toBe('principle');
    });
  });
});
