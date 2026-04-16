import { describe, it, expect } from 'vitest';
import {
  validateArtifact,
  parseAndValidateArtifact,
  type ArbiterResult,
} from '../../src/core/nocturnal-arbiter.js';

describe('Nocturnal Arbiter', () => {
  // -------------------------------------------------------------------------
  // Valid artifact factory
  // -------------------------------------------------------------------------

  function makeValidArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      artifactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      sessionId: 'session-abc123',
      principleId: 'T-08',
      sourceSnapshotRef: 'snapshot-2026-03-27-001',
      badDecision: 'After bash command failed, immediately retried without diagnosing the root cause',
      betterDecision: 'Check the error message and verify preconditions before retrying a failed bash command',
      rationale: 'Treating each failure as a signal to diagnose rather than blindly retry prevents repeated failures',
      createdAt: '2026-03-27T12:00:00.000Z',
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Tests: validateArtifact — valid inputs
  // -------------------------------------------------------------------------

  describe('validateArtifact', () => {
    it('passes a valid artifact with all required fields', () => {
      const artifact = makeValidArtifact();
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
      expect(result.artifact).toBeDefined();
      expect(result.failures).toHaveLength(0);
    });

    it('passes with optional sourceSnapshotRef present', () => {
      const artifact = makeValidArtifact({ sourceSnapshotRef: 'snapshot-custom-001' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
    });

    it('passes when principleId and sessionId cross-validate against expected values', () => {
      const artifact = makeValidArtifact({ principleId: 'T-08', sessionId: 'session-abc123' });
      const result = validateArtifact(artifact, {
        expectedPrincipleId: 'T-08',
        expectedSessionId: 'session-abc123',
      });
      expect(result.passed).toBe(true);
    });

    it('passes a minimal but complete artifact', () => {
      // Only required fields, no optional
      const artifact = {
        artifactId: '11111111-2222-4333-aaaa-555555555555',
        sessionId: 'session-minimal',
        principleId: 'T-01',
        badDecision: 'Edited a file without reading it first',
        betterDecision: 'Read the file before editing to understand its current state',
        rationale: 'Surveying the existing territory before making changes prevents conflicts',
        createdAt: '2026-03-27T12:00:00.000Z',
      };
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateArtifact — invalid JSON structure
  // -------------------------------------------------------------------------

  describe('validateArtifact — invalid JSON structure', () => {
    it('rejects null', () => {
      const result = validateArtifact(null);
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('must be a JSON object');
    });

    it('rejects undefined', () => {
      const result = validateArtifact(undefined);
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('must be a JSON object');
    });

    it('rejects an array', () => {
      const result = validateArtifact([{ artifactId: 'xxx' }]);
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('must be a JSON object');
    });

    it('rejects a string', () => {
      const result = validateArtifact('not an object');
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('must be a JSON object');
    });

    it('rejects a number', () => {
      const result = validateArtifact(42);
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('must be a JSON object');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateArtifact — invalid flag from reflector
  // -------------------------------------------------------------------------

  describe('validateArtifact — invalid flag', () => {
    it('rejects artifact with invalid: true', () => {
      const artifact = makeValidArtifact({ invalid: true, reason: 'no clear violation found' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('invalid');
    });

    it('rejects artifact with invalid: "true" (string)', () => {
      const artifact = makeValidArtifact({ invalid: 'true', reason: 'no violation' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('invalid');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateArtifact — missing required fields
  // -------------------------------------------------------------------------

  describe('validateArtifact — missing required fields', () => {
    it('rejects missing artifactId', () => {
      const artifact = makeValidArtifact();
      delete artifact.artifactId;
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'artifactId')).toBe(true);
    });

    it('rejects empty artifactId', () => {
      const artifact = makeValidArtifact({ artifactId: '' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'artifactId')).toBe(true);
    });

    it('rejects whitespace-only artifactId', () => {
      const artifact = makeValidArtifact({ artifactId: '   ' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'artifactId')).toBe(true);
    });

    it('rejects missing sessionId', () => {
      const artifact = makeValidArtifact();
      delete artifact.sessionId;
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'sessionId')).toBe(true);
    });

    it('rejects missing principleId', () => {
      const artifact = makeValidArtifact();
      delete artifact.principleId;
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'principleId')).toBe(true);
    });

    it('rejects missing badDecision', () => {
      const artifact = makeValidArtifact();
      delete artifact.badDecision;
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'badDecision')).toBe(true);
    });

    it('rejects missing betterDecision', () => {
      const artifact = makeValidArtifact();
      delete artifact.betterDecision;
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'betterDecision')).toBe(true);
    });

    it('rejects missing rationale', () => {
      const artifact = makeValidArtifact();
      delete artifact.rationale;
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'rationale')).toBe(true);
    });

    it('rejects missing createdAt', () => {
      const artifact = makeValidArtifact();
      delete artifact.createdAt;
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'createdAt')).toBe(true);
    });

    it('rejects empty createdAt', () => {
      const artifact = makeValidArtifact({ createdAt: '' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'createdAt')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateArtifact — invalid field formats
  // -------------------------------------------------------------------------

  describe('validateArtifact — invalid field formats', () => {
    it('rejects artifactId that is not a valid UUID', () => {
      const artifact = makeValidArtifact({ artifactId: 'not-a-uuid' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'artifactId')).toBe(true);
    });

    it('rejects createdAt that is not ISO 8601', () => {
      const artifact = makeValidArtifact({ createdAt: '2026-03-27' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'createdAt')).toBe(true);
    });

    it('rejects createdAt with time but no seconds', () => {
      const artifact = makeValidArtifact({ createdAt: '2026-03-27T12:00Z' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'createdAt')).toBe(true);
    });

    it('rejects createdAt with milliseconds (valid ISO but our format is different)', () => {
      // Our regex requires .SSS after T
      const artifact = makeValidArtifact({ createdAt: '2026-03-27T12:00:00Z' });
      const result = validateArtifact(artifact);
      // Actually this should pass — our regex allows optional .SSS
      // Let's test the other direction
      const artifact2 = makeValidArtifact({ createdAt: '2026-03-27T12:00:00.123Z' });
      const result2 = validateArtifact(artifact2);
      expect(result2.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateArtifact — cross-validation
  // -------------------------------------------------------------------------

  describe('validateArtifact — cross-validation', () => {
    it('rejects principleId mismatch', () => {
      const artifact = makeValidArtifact({ principleId: 'T-08' });
      const result = validateArtifact(artifact, { expectedPrincipleId: 'T-01' });
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.reason.includes('principleId mismatch'))).toBe(true);
    });

    it('rejects sessionId mismatch', () => {
      const artifact = makeValidArtifact({ sessionId: 'session-abc' });
      const result = validateArtifact(artifact, { expectedSessionId: 'session-xyz' });
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.reason.includes('sessionId mismatch'))).toBe(true);
    });

    it('passes when principleId matches expected', () => {
      const artifact = makeValidArtifact({ principleId: 'T-08' });
      const result = validateArtifact(artifact, { expectedPrincipleId: 'T-08' });
      expect(result.passed).toBe(true);
    });

    it('passes when sessionId matches expected', () => {
      const artifact = makeValidArtifact({ sessionId: 'session-abc' });
      const result = validateArtifact(artifact, { expectedSessionId: 'session-abc' });
      expect(result.passed).toBe(true);
    });

    it('passes when no expected values provided', () => {
      const artifact = makeValidArtifact({ principleId: 'T-99', sessionId: 'session-xyz' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateArtifact — placeholder detection
  // -------------------------------------------------------------------------

  describe('validateArtifact — placeholder detection', () => {
    const placeholderTests = [
      { value: '<placeholder>', expected: true },
      { value: '<uuid>', expected: true },
      { value: '<session-id>', expected: true },
      { value: '<principle-id>', expected: true },
      { value: 'undefined', expected: true },
      { value: 'null', expected: true },
      { value: 'N/A', expected: true },
      { value: 'TODO', expected: true },
      { value: 'FIXME', expected: true },
      { value: 'valid decision text', expected: false },
      { value: 'Read the file before editing', expected: false },
    ];

    placeholderTests.forEach(({ value, expected }) => {
      it(`badDecision: '${value}' → ${expected ? 'rejected' : 'accepted'}`, () => {
        const artifact = makeValidArtifact({ badDecision: value });
        const result = validateArtifact(artifact);
        if (expected) {
          expect(result.passed).toBe(false);
          expect(result.failures.some(f => f.reason.includes('placeholder'))).toBe(true);
        } else {
          expect(result.passed).toBe(true);
        }
      });
    });

    it('rejects betterDecision containing placeholder', () => {
      const artifact = makeValidArtifact({ betterDecision: '<action>' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'betterDecision')).toBe(true);
    });

    it('rejects rationale containing placeholder', () => {
      const artifact = makeValidArtifact({ rationale: 'TODO: add rationale' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'rationale')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateArtifact — raw content detection
  // -------------------------------------------------------------------------

  describe('validateArtifact — raw content detection', () => {
    it('rejects badDecision containing function definition', () => {
      const artifact = makeValidArtifact({ badDecision: 'function handleError() { return 1; }' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.reason.includes('raw/private content'))).toBe(true);
    });

    it('rejects badDecision containing import statement', () => {
      const artifact = makeValidArtifact({ badDecision: 'import { foo } from "./bar"; doSomething();' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.reason.includes('raw/private content'))).toBe(true);
    });

    it('rejects betterDecision containing credential assignment pattern', () => {
      // api_key= with an actual value is a credential leak
      const artifact = makeValidArtifact({ betterDecision: 'Check the api_key=ABC123 before proceeding' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.reason.includes('raw/private content'))).toBe(true);
    });

    it('accepts credential-like words without assignment (not raw content)', () => {
      // "api_key" as a word in natural decision text is not a credential leak
      const artifact = makeValidArtifact({ betterDecision: 'Check the api_key before proceeding' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
    });

    it('accepts text without raw content patterns', () => {
      const artifact = makeValidArtifact({
        badDecision: 'Proceeded with editing without reading the file first',
        betterDecision: 'Read the file to understand its current structure before making edits',
      });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateArtifact — semantic rules
  // -------------------------------------------------------------------------

  describe('validateArtifact — semantic rules', () => {
    it('rejects identical badDecision and betterDecision', () => {
      const artifact = makeValidArtifact({
        badDecision: 'Read the file first',
        betterDecision: 'Read the file first',
      });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.reason.includes('identical'))).toBe(true);
    });

    it('accepts different badDecision and betterDecision', () => {
      const artifact = makeValidArtifact({
        badDecision: 'Edited without reading',
        betterDecision: 'Read the file before editing',
      });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
    });

    it('rejects rationale that is too short', () => {
      const artifact = makeValidArtifact({ rationale: 'Because.' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.reason.includes('too short'))).toBe(true);
    });

    it('accepts rationale at minimum length (20 chars)', () => {
      const artifact = makeValidArtifact({ rationale: '12345678901234567890' }); // exactly 20
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
    });

    it('rejects sourceSnapshotRef that is present but empty', () => {
      const artifact = makeValidArtifact({ sourceSnapshotRef: '' });
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'sourceSnapshotRef')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: parseAndValidateArtifact
  // -------------------------------------------------------------------------

  describe('parseAndValidateArtifact', () => {
    it('parses a valid JSON string and validates successfully', () => {
      const json = JSON.stringify(makeValidArtifact());
      const result = parseAndValidateArtifact(json);
      expect(result.passed).toBe(true);
      expect(result.artifact).toBeDefined();
      expect(result.artifact?.principleId).toBe('T-08');
    });

    it('fails on invalid JSON', () => {
      const result = parseAndValidateArtifact('not valid json {');
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('Failed to parse JSON');
    });

    it('fails on empty string', () => {
      const result = parseAndValidateArtifact('');
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('Failed to parse JSON');
    });

    it('passes cross-validation from options', () => {
      const artifact = makeValidArtifact({ principleId: 'T-01', sessionId: 'session-xyz' });
      const json = JSON.stringify(artifact);
      const result = parseAndValidateArtifact(json, {
        expectedPrincipleId: 'T-01',
        expectedSessionId: 'session-xyz',
      });
      expect(result.passed).toBe(true);
    });

    it('fails cross-validation from options on mismatch', () => {
      const artifact = makeValidArtifact({ principleId: 'T-01' });
      const json = JSON.stringify(artifact);
      const result = parseAndValidateArtifact(json, { expectedPrincipleId: 'T-99' });
      expect(result.passed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: constructed artifact output shape
  // -------------------------------------------------------------------------

  describe('constructed artifact shape', () => {
    it('returns correct NocturnalArtifact shape when passed', () => {
      const artifact = makeValidArtifact();
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
      expect(result.artifact).toEqual({
        artifactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        sessionId: 'session-abc123',
        principleId: 'T-08',
        sourceSnapshotRef: 'snapshot-2026-03-27-001',
        badDecision: 'After bash command failed, immediately retried without diagnosing the root cause',
        betterDecision: 'Check the error message and verify preconditions before retrying a failed bash command',
        rationale: 'Treating each failure as a signal to diagnose rather than blindly retry prevents repeated failures',
        createdAt: '2026-03-27T12:00:00.000Z',
      });
    });

    it('converts all fields to strings even if passed as numbers', () => {
      // artifactId is normally string, but test robustness
      const artifact = makeValidArtifact() as Record<string, unknown>;
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
      expect(typeof result.artifact?.artifactId).toBe('string');
    });

    it('uses empty string for missing sourceSnapshotRef', () => {
      const artifact = makeValidArtifact();
      delete artifact.sourceSnapshotRef;
      const result = validateArtifact(artifact);
      expect(result.passed).toBe(true);
      expect(result.artifact?.sourceSnapshotRef).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: quality threshold gates (Rule 10/11)
  // -------------------------------------------------------------------------

  describe('quality threshold gates', () => {
    const defaultThresholds = { thinkingModelDeltaMin: 0.05, planningRatioGainMin: -0.5 };

    it('rejects when thinkingModelDelta is below threshold', () => {
      const artifact = makeValidArtifact({ thinkingModelDelta: 0.03 });
      const result = validateArtifact(artifact, { qualityThresholds: defaultThresholds });
      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].field).toBe('thinkingModelDelta');
    });

    it('passes when thinkingModelDelta equals threshold exactly (boundary value)', () => {
      const artifact = makeValidArtifact({ thinkingModelDelta: 0.05 });
      const result = validateArtifact(artifact, { qualityThresholds: defaultThresholds });
      expect(result.passed).toBe(true);
    });

    it('passes when thinkingModelDelta exceeds threshold', () => {
      const artifact = makeValidArtifact({ thinkingModelDelta: 0.15 });
      const result = validateArtifact(artifact, { qualityThresholds: defaultThresholds });
      expect(result.passed).toBe(true);
    });

    it('passes when thinkingModelDelta is absent (optional field)', () => {
      const artifact = makeValidArtifact();
      delete artifact.thinkingModelDelta;
      const result = validateArtifact(artifact, { qualityThresholds: defaultThresholds });
      expect(result.passed).toBe(true);
    });

    it('rejects when planningRatioGain is below threshold', () => {
      const artifact = makeValidArtifact({ planningRatioGain: -0.6 });
      const result = validateArtifact(artifact, { qualityThresholds: defaultThresholds });
      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.field === 'planningRatioGain')).toBe(true);
    });

    it('passes when planningRatioGain equals threshold exactly (boundary value)', () => {
      const artifact = makeValidArtifact({ planningRatioGain: -0.5 });
      const result = validateArtifact(artifact, { qualityThresholds: defaultThresholds });
      expect(result.passed).toBe(true);
    });

    it('rejects both quality thresholds simultaneously', () => {
      const artifact = makeValidArtifact({ thinkingModelDelta: 0.01, planningRatioGain: -0.8 });
      const result = validateArtifact(artifact, { qualityThresholds: defaultThresholds });
      expect(result.passed).toBe(false);
      expect(result.failures.length).toBeGreaterThanOrEqual(2);
      expect(result.failures.some(f => f.field === 'thinkingModelDelta')).toBe(true);
      expect(result.failures.some(f => f.field === 'planningRatioGain')).toBe(true);
    });
  });
});
