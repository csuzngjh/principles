/**
 * EP002-R3 — intentContract string-encoding normalization.
 *
 * Live evidence (glm-5.3-flash, structured-output path, 2026-09-13): the
 * model serializes the nested `intentContract` object as a JSON-encoded
 * STRING. The contract information is complete; only the carrier is wrong.
 * `normalizeStringEncodedIntentContract` normalizes the carrier in place so
 * the validator's present-but-malformed hard rejection does not dead-end the
 * scribe stage on a semantically valid contract.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeStringEncodedIntentContract,
  DefaultScribeValidator,
} from '../scribe-output.js';

const VALID_CONTRACT = {
  ownerIntent: 'prevent stale wording from being merged without verification',
  targetBehavior: 'verify the authoritative source before any state merge',
  forbiddenBehavior: 'merging outdated entries into the state file without verification',
  evidenceSource: 'manual_1789317326914_sj6p6a92 (T-08 recurrence)',
  validationExpectation: 'rule must block merge-shaped writes with no prior verification call in session',
};

describe('normalizeStringEncodedIntentContract', () => {
  it('normalizes a JSON-encoded intentContract string in place', () => {
    const output: Record<string, unknown> = {
      taskId: 't1',
      intentContract: JSON.stringify(VALID_CONTRACT),
    };
    expect(normalizeStringEncodedIntentContract(output)).toBe(true);
    expect(output.intentContract).toEqual(VALID_CONTRACT);
  });

  it('leaves a proper object untouched', () => {
    const output: Record<string, unknown> = { intentContract: { ...VALID_CONTRACT } };
    expect(normalizeStringEncodedIntentContract(output)).toBe(false);
    expect(output.intentContract).toEqual(VALID_CONTRACT);
  });

  it('leaves a missing intentContract untouched', () => {
    const output: Record<string, unknown> = { taskId: 't1' };
    expect(normalizeStringEncodedIntentContract(output)).toBe(false);
    expect(Object.hasOwn(output, 'intentContract')).toBe(false);
  });

  it('leaves an unparseable string untouched (validator rejects loudly)', () => {
    const output: Record<string, unknown> = { intentContract: '{not json' };
    expect(normalizeStringEncodedIntentContract(output)).toBe(false);
    expect(output.intentContract).toBe('{not json');
  });

  it('leaves a string parsing to a non-object untouched', () => {
    const output: Record<string, unknown> = { intentContract: JSON.stringify(['a', 'b']) };
    expect(normalizeStringEncodedIntentContract(output)).toBe(false);
    expect(output.intentContract).toBe(JSON.stringify(['a', 'b']));
  });

  it('ignores non-object roots', () => {
    expect(normalizeStringEncodedIntentContract(null)).toBe(false);
    expect(normalizeStringEncodedIntentContract('string')).toBe(false);
    expect(normalizeStringEncodedIntentContract([1, 2])).toBe(false);
  });

  it('after normalization the output passes DefaultScribeValidator contract check', async () => {
    const output: Record<string, unknown> = {
      taskId: 't1',
      sourcePhilosopherArtifactId: 'pi-art-philosopher-x',
      principleDraft: {
        title: 'Verify before merge',
        statement: 'Verify the authoritative source before merging.',
        rationale: 'Ordering constraint was missing.',
        applicability: ['state file sync'],
        antiPatterns: ['verify-after-merge'],
        confidence: 0.9,
      },
      sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-x' },
      risks: [],
      generatedAt: new Date().toISOString(),
      intentContract: JSON.stringify(VALID_CONTRACT),
    };
    normalizeStringEncodedIntentContract(output);
    const validator = new DefaultScribeValidator();
    const result = await validator.validate(output, 't1', 'pi-art-philosopher-x');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
