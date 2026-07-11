import { describe, it, expect, vi } from 'vitest';
import { CandidateIntakeService } from '../candidate-intake-service.js';
import { CandidateIntakeError, INTAKE_ERROR_CODES, validateRecommendation } from '../candidate-intake.js';
import type { LedgerAdapter, LedgerPrincipleEntry, Recommendation } from '../candidate-intake.js';

const makeLedgerEntry = (overrides: Partial<LedgerPrincipleEntry> = {}): LedgerPrincipleEntry => ({
  id: 'ledger-entry-1',
  title: 'Test Principle',
  text: 'Test principle text',
  status: 'probation',
  evaluability: 'weak_heuristic',
  sourceRef: 'candidate://cand-1',
  createdAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const makeMockStateManager = (opts: {
  candidate?: { candidateId: string; artifactId: string; title: string; description: string; sourceRecommendationJson: string; taskId?: string };
  artifact?: { contentJson: string };
}) => ({
  getCandidate: vi.fn(async (id: string) => {
    if (opts.candidate?.candidateId === id) return opts.candidate;
    return null;
  }),
  getArtifact: vi.fn(async (id: string) => {
    if (opts.artifact) return opts.artifact;
    return null;
  }),
});

const makeMockLedgerAdapter = (opts: {
  existsForCandidate?: LedgerPrincipleEntry | null;
  writeProbationEntry?: LedgerPrincipleEntry | ((entry: LedgerPrincipleEntry) => LedgerPrincipleEntry);
}) => ({
  existsForCandidate: vi.fn((id: string) => opts.existsForCandidate ?? null),
  writeProbationEntry: vi.fn((entry: LedgerPrincipleEntry) => {
    if (typeof opts.writeProbationEntry === 'function') {
      return opts.writeProbationEntry(entry);
    }
    return opts.writeProbationEntry ?? entry;
  }),
});

describe('CandidateIntakeService', () => {
  describe('input validation', () => {
    it('throws INPUT_INVALID for empty candidateId', async () => {
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({}) as never,
        ledgerAdapter: makeMockLedgerAdapter({}) as never,
      });

      await expect(service.intake('')).rejects.toThrow(CandidateIntakeError);
      await expect(service.intake('')).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.INPUT_INVALID });
    });

    it('throws INPUT_INVALID for whitespace-only candidateId', async () => {
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({}) as never,
        ledgerAdapter: makeMockLedgerAdapter({}) as never,
      });

      await expect(service.intake('   ')).rejects.toThrow(CandidateIntakeError);
      await expect(service.intake('   ')).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.INPUT_INVALID });
    });

    it('throws INPUT_INVALID for non-string candidateId', async () => {
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({}) as never,
        ledgerAdapter: makeMockLedgerAdapter({}) as never,
      });

      // @ts-expect-error testing invalid input
      await expect(service.intake(123)).rejects.toThrow(CandidateIntakeError);
      await expect(service.intake(123 as never)).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.INPUT_INVALID });
    });

    it('throws INPUT_INVALID for null candidateId', async () => {
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({}) as never,
        ledgerAdapter: makeMockLedgerAdapter({}) as never,
      });

      // @ts-expect-error testing invalid input
      await expect(service.intake(null)).rejects.toThrow(CandidateIntakeError);
    });
  });

  describe('idempotency', () => {
    it('returns existing ledger entry without writing (idempotent)', async () => {
      const existingEntry = makeLedgerEntry({ sourceRef: 'candidate://cand-1' });
      const ledgerAdapter = makeMockLedgerAdapter({ existsForCandidate: existingEntry });
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({}) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      const result = await service.intake('cand-1');

      expect(result).toBe(existingEntry);
      expect(ledgerAdapter.writeProbationEntry).not.toHaveBeenCalled();
    });
  });

  describe('candidate lookup', () => {
    it('throws CANDIDATE_NOT_FOUND when candidate does not exist', async () => {
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({}) as never,
        ledgerAdapter: makeMockLedgerAdapter({}) as never,
      });

      await expect(service.intake('cand-not-found')).rejects.toThrow(CandidateIntakeError);
      await expect(service.intake('cand-not-found')).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.CANDIDATE_NOT_FOUND });
    });
  });

  describe('artifact lookup', () => {
    it('throws ARTIFACT_NOT_FOUND when artifact does not exist', async () => {
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: { candidateId: 'cand-1', artifactId: 'art-1', title: 'Test', description: 'desc', sourceRecommendationJson: '' },
        }) as never,
        ledgerAdapter: makeMockLedgerAdapter({}) as never,
      });

      await expect(service.intake('cand-1')).rejects.toThrow(CandidateIntakeError);
      await expect(service.intake('cand-1')).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.ARTIFACT_NOT_FOUND });
    });
  });

  describe('recommendation extraction', () => {
    it('extracts recommendation from sourceRecommendationJson (canonical path)', async () => {
      const ledgerAdapter = makeMockLedgerAdapter({});
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'desc',
            sourceRecommendationJson: JSON.stringify({ text: 'From candidate', triggerPattern: 'pattern', action: 'action' }),
          },
          artifact: { contentJson: JSON.stringify({ text: 'From artifact' }) },
        }) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      const result = await service.intake('cand-1');

      expect(result.text).toBe('From candidate');
      expect(result.triggerPattern).toBe('pattern');
      expect(result.action).toBe('action');
    });

    it('normalizes DiagnosticianRecommendation (description → text)', async () => {
      const ledgerAdapter = makeMockLedgerAdapter({});
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'desc',
            sourceRecommendationJson: JSON.stringify({ description: 'From description' }),
          },
          artifact: { contentJson: JSON.stringify({ text: 'From artifact' }) },
        }) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      const result = await service.intake('cand-1');

      expect(result.text).toBe('From description');
    });

    it('falls back to artifact.contentJson when sourceRecommendationJson is empty', async () => {
      const ledgerAdapter = makeMockLedgerAdapter({});
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'desc',
            sourceRecommendationJson: '',
          },
          artifact: { contentJson: JSON.stringify({ text: 'From artifact content' }) },
        }) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      const result = await service.intake('cand-1');

      expect(result.text).toBe('From artifact content');
    });

    it('falls back to artifact.contentJson when sourceRecommendationJson is malformed', async () => {
      const ledgerAdapter = makeMockLedgerAdapter({});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'desc',
            sourceRecommendationJson: '{invalid json',
          },
          artifact: { contentJson: JSON.stringify({ text: 'From artifact fallback' }) },
        }) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      const result = await service.intake('cand-1');

      expect(result.text).toBe('From artifact fallback');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('extracts from { recommendation: {...} } wrapper in contentJson', async () => {
      const ledgerAdapter = makeMockLedgerAdapter({});
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'desc',
            sourceRecommendationJson: '',
          },
          artifact: { contentJson: JSON.stringify({ recommendation: { text: 'From wrapper' } }) },
        }) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      const result = await service.intake('cand-1');

      expect(result.text).toBe('From wrapper');
    });

    it('extracts from DiagnosticianOutputV1 recommendations array', async () => {
      const ledgerAdapter = makeMockLedgerAdapter({});
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'desc',
            sourceRecommendationJson: '',
          },
          artifact: { contentJson: JSON.stringify({ recommendations: [{ description: 'From diag output' }] }) },
        }) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      const result = await service.intake('cand-1');

      expect(result.text).toBe('From diag output');
    });

    it('throws INPUT_INVALID when no valid recommendation can be extracted', async () => {
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'desc',
            sourceRecommendationJson: '',
          },
          artifact: { contentJson: JSON.stringify({ unrelatedField: 'value' }) },
        }) as never,
        ledgerAdapter: makeMockLedgerAdapter({}) as never,
      });

      await expect(service.intake('cand-1')).rejects.toThrow(CandidateIntakeError);
      await expect(service.intake('cand-1')).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.INPUT_INVALID });
    });

    it('falls back to candidate.description when text is empty', async () => {
      const ledgerAdapter = makeMockLedgerAdapter({});
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'Fallback description',
            sourceRecommendationJson: JSON.stringify({ text: '' }),
          },
          artifact: { contentJson: '{}' },
        }) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      const result = await service.intake('cand-1');

      expect(result.text).toBe('Fallback description');
    });
  });

  describe('ledger entry construction', () => {
    it('builds correct LedgerPrincipleEntry with all fields', async () => {
      const ledgerAdapter = makeMockLedgerAdapter({});
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'desc',
            sourceRecommendationJson: JSON.stringify({ text: 'Principle text' }),
            taskId: 'task-1',
          },
          artifact: { contentJson: '{}' },
        }) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      const result = await service.intake('cand-1');

      expect(result.id).toBeDefined();
      expect(result.title).toBe('Test Principle');
      expect(result.text).toBe('Principle text');
      expect(result.status).toBe('probation');
      expect(result.evaluability).toBe('weak_heuristic');
      expect(result.sourceRef).toBe('candidate://cand-1');
      expect(result.artifactRef).toBe('artifact://art-1');
      expect(result.taskRef).toBe('task://task-1');
      expect(result.createdAt).toBeDefined();
    });

    it('does not set taskRef when taskId is undefined', async () => {
      const ledgerAdapter = makeMockLedgerAdapter({});
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'desc',
            sourceRecommendationJson: JSON.stringify({ text: 'Principle text' }),
          },
          artifact: { contentJson: '{}' },
        }) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      const result = await service.intake('cand-1');

      expect(result.taskRef).toBeUndefined();
    });
  });

  describe('ledger write failure', () => {
    it('throws LEDGER_WRITE_FAILED when adapter throws', async () => {
      const ledgerAdapter = makeMockLedgerAdapter({
        writeProbationEntry: () => { throw new Error('Ledger write failed'); },
      });
      const service = new CandidateIntakeService({
        stateManager: makeMockStateManager({
          candidate: {
            candidateId: 'cand-1',
            artifactId: 'art-1',
            title: 'Test Principle',
            description: 'desc',
            sourceRecommendationJson: JSON.stringify({ text: 'Principle text' }),
          },
          artifact: { contentJson: '{}' },
        }) as never,
        ledgerAdapter: ledgerAdapter as never,
      });

      await expect(service.intake('cand-1')).rejects.toThrow(CandidateIntakeError);
      await expect(service.intake('cand-1')).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.LEDGER_WRITE_FAILED });
    });
  });
});

describe('validateRecommendation', () => {
  it('returns null for non-object input', () => {
    expect(validateRecommendation(null)).toBeNull();
    expect(validateRecommendation(undefined)).toBeNull();
    expect(validateRecommendation('string')).toBeNull();
    expect(validateRecommendation(123)).toBeNull();
    expect(validateRecommendation([])).toBeNull();
  });

  it('returns null for object with no known fields', () => {
    expect(validateRecommendation({ unknown: 'value' })).toBeNull();
    expect(validateRecommendation({})).toBeNull();
  });

  it('returns null when known field is wrong type', () => {
    expect(validateRecommendation({ text: 123 })).toBeNull();
    expect(validateRecommendation({ triggerPattern: {} })).toBeNull();
  });

  it('returns valid recommendation with string fields', () => {
    const result = validateRecommendation({ text: 'test', triggerPattern: 'pattern' });
    expect(result).toEqual({ text: 'test', triggerPattern: 'pattern' });
  });

  it('accepts partial recommendations (only title)', () => {
    const result = validateRecommendation({ title: 'My Title' });
    expect(result).toEqual({ title: 'My Title' });
  });

  it('accepts partial recommendations (only action)', () => {
    const result = validateRecommendation({ action: 'do something' });
    expect(result).toEqual({ action: 'do something' });
  });
});