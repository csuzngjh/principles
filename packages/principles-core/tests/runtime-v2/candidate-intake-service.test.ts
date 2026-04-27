import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CandidateIntakeService } from '../../src/runtime-v2/candidate-intake-service.js';
import { CandidateIntakeError, INTAKE_ERROR_CODES } from '@principles/core/runtime-v2';
import type { LedgerPrincipleEntry } from '@principles/core/runtime-v2';
import type { RuntimeStateManager } from '../../src/runtime-v2/store/runtime-state-manager.js';
import type { LedgerAdapter } from '@principles/core/runtime-v2';

// ── Test Factories ──────────────────────────────────────────

function createMockStateManager(overrides = {}) {
  return {
    getCandidate: vi.fn(),
    getArtifact: vi.fn(),
    updateCandidateStatus: vi.fn(),
    ...overrides,
  } as unknown as RuntimeStateManager;
}

function createMockLedgerAdapter(overrides = {}) {
  return {
    writeProbationEntry: vi.fn(),
    existsForCandidate: vi.fn(),
    ...overrides,
  } as unknown as LedgerAdapter;
}

function createCandidate(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: 'test-candidate-001',
    artifactId: 'test-artifact-001',
    taskId: 'test-task-001',
    sourceRunId: 'run-001',
    title: 'Always verify backup before delete',
    description: 'When deleting files, always verify backup exists first for safety.',
    confidence: 0.95,
    sourceRecommendationJson: JSON.stringify({
      recommendation: {
        title: 'Always verify backup before delete',
        text: 'When deleting files, always verify backup exists first for safety.',
        triggerPattern: 'file delete',
        action: 'verify backup exists',
      },
    }),
    status: 'pending' as const,
    createdAt: '2026-04-26T10:00:00.000Z',
    ...overrides,
  };
}

function createArtifact(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: 'test-artifact-001',
    runId: 'run-001',
    taskId: 'test-task-001',
    artifactKind: 'diagnostician_output',
    contentJson: JSON.stringify({
      recommendation: {
        title: 'Always verify backup before delete',
        text: 'When deleting files, always verify backup exists first for safety.',
        triggerPattern: 'file delete',
        action: 'verify backup exists',
      },
    }),
    createdAt: '2026-04-26T10:00:00.000Z',
    ...overrides,
  };
}

function createLedgerEntry(overrides: Partial<LedgerPrincipleEntry> = {}) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Always verify backup before delete',
    text: 'When deleting files, always verify backup exists first for safety.',
    triggerPattern: 'file delete',
    action: 'verify backup exists',
    status: 'probation',
    evaluability: 'weak_heuristic',
    sourceRef: 'candidate://test-candidate-001',
    artifactRef: 'artifact://test-artifact-001',
    taskRef: 'task://test-task-001',
    createdAt: '2026-04-26T10:00:00.000Z',
    ...overrides,
  } as LedgerPrincipleEntry;
}

// ── Helper to check CandidateIntakeError ─────────────────────

function expectCandidateError(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).name).toBe('CandidateIntakeError');
  expect((err as CandidateIntakeError).code).toBe(code);
}

// ── Tests ───────────────────────────────────────────────────

describe('CandidateIntakeService', () => {
  let mockStateManager: RuntimeStateManager;
  let mockLedgerAdapter: LedgerAdapter;
  let service: CandidateIntakeService;

  beforeEach(() => {
    mockStateManager = createMockStateManager();
    mockLedgerAdapter = createMockLedgerAdapter();
    service = new CandidateIntakeService({
      stateManager: mockStateManager,
      ledgerAdapter: mockLedgerAdapter,
    });
  });

  // ── Constructor ──────────────────────────────────────────

  it('should accept stateManager and ledgerAdapter in constructor', () => {
    expect(service).toBeInstanceOf(CandidateIntakeService);
  });

  // ── intake() happy path ──────────────────────────────────

  describe('intake() happy path', () => {
    it('writes ledger entry and returns LedgerPrincipleEntry', async () => {
      const candidate = createCandidate();
      const artifact = createArtifact();

      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(artifact);
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation((e) => e);

      const result = await service.intake('test-candidate-001');

      expect(result).toBeDefined();
      expect(result.title).toBe(candidate.title);
      expect(result.sourceRef).toBe('candidate://test-candidate-001');
      expect(mockLedgerAdapter.writeProbationEntry).toHaveBeenCalledOnce();
    });

    it('built entry has correct 11 fields', async () => {
      const candidate = createCandidate();
      const artifact = createArtifact();

      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(artifact);
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);

      let capturedEntry: LedgerPrincipleEntry | null = null;
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation((e: LedgerPrincipleEntry) => {
        capturedEntry = e;
        return e;
      });

      await service.intake('test-candidate-001');

      expect(capturedEntry).not.toBeNull();
      expect(capturedEntry!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(capturedEntry!.title).toBe(candidate.title);
      expect(capturedEntry!.text).toBe('When deleting files, always verify backup exists first for safety.');
      expect(capturedEntry!.triggerPattern).toBe('file delete');
      expect(capturedEntry!.action).toBe('verify backup exists');
      expect(capturedEntry!.status).toBe('probation');
      expect(capturedEntry!.evaluability).toBe('weak_heuristic');
      expect(capturedEntry!.sourceRef).toBe('candidate://test-candidate-001');
      expect(capturedEntry!.artifactRef).toBe('artifact://test-artifact-001');
      expect(capturedEntry!.taskRef).toBe('task://test-task-001');
      expect(capturedEntry!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('does NOT update candidate status in service (deferred to m7-04)', async () => {
      const candidate = createCandidate();
      const artifact = createArtifact();

      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(artifact);
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation((e) => e);

      await service.intake('test-candidate-001');

      expect(mockStateManager.updateCandidateStatus).not.toHaveBeenCalled();
    });
  });

  // ── intake() idempotency ──────────────────────────────────

  describe('intake() idempotency', () => {
    it('returns existing entry if adapter already has it (E-02, D-10)', async () => {
      const existingEntry = createLedgerEntry();
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(existingEntry);

      const result = await service.intake('test-candidate-001');

      expect(result).toBe(existingEntry);
      expect(mockStateManager.getCandidate).not.toHaveBeenCalled();
      expect(mockLedgerAdapter.writeProbationEntry).not.toHaveBeenCalled();
    });

    it('different candidates produce different entries', async () => {
      const candidate1 = createCandidate({ candidateId: 'candidate-A', artifactId: 'artifact-A' });
      const candidate2 = createCandidate({ candidateId: 'candidate-B', artifactId: 'artifact-B' });
      const artifact1 = createArtifact({ artifactId: 'artifact-A' });
      const artifact2 = createArtifact({ artifactId: 'artifact-B' });

      vi.spyOn(mockLedgerAdapter, 'existsForCandidate')
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null);
      vi.spyOn(mockStateManager, 'getCandidate')
        .mockResolvedValueOnce(candidate1)
        .mockResolvedValueOnce(candidate2);
      vi.spyOn(mockStateManager, 'getArtifact')
        .mockResolvedValueOnce(artifact1)
        .mockResolvedValueOnce(artifact2);
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation((e: LedgerPrincipleEntry) => e);

      const result1 = await service.intake('candidate-A');
      const result2 = await service.intake('candidate-B');

      expect(result1.sourceRef).toBe('candidate://candidate-A');
      expect(result2.sourceRef).toBe('candidate://candidate-B');
      expect(mockLedgerAdapter.writeProbationEntry).toHaveBeenCalledTimes(2);
    });
  });

  // ── intake() error handling ──────────────────────────────────

  describe('intake() error handling', () => {
    it('throws CANDIDATE_NOT_FOUND when candidate does not exist (E-01)', async () => {
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(null);

      try {
        await service.intake('nonexistent-candidate');
      } catch (err: unknown) {
        expectCandidateError(err, INTAKE_ERROR_CODES.CANDIDATE_NOT_FOUND);
      }

      await expect(service.intake('nonexistent-candidate')).rejects.toThrow();
      expect(mockLedgerAdapter.writeProbationEntry).not.toHaveBeenCalled();
    });

    it('throws ARTIFACT_NOT_FOUND when artifact is missing (E-04)', async () => {
      const candidate = createCandidate();
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(null);

      try {
        await service.intake('test-candidate-001');
      } catch (err: unknown) {
        expectCandidateError(err, INTAKE_ERROR_CODES.ARTIFACT_NOT_FOUND);
      }

      await expect(service.intake('test-candidate-001')).rejects.toThrow();
    });

    it('throws INPUT_INVALID when artifact content parse fails', async () => {
      const candidate = createCandidate();
      const badArtifact = createArtifact({ contentJson: 'invalid json' });
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(badArtifact);

      try {
        await service.intake('test-candidate-001');
      } catch (err: unknown) {
        expectCandidateError(err, INTAKE_ERROR_CODES.INPUT_INVALID);
      }
    });

    it('throws LEDGER_WRITE_FAILED when adapter write fails with CandidateIntakeError', async () => {
      const candidate = createCandidate();
      const artifact = createArtifact();
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(artifact);
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation(() => {
        throw new CandidateIntakeError(INTAKE_ERROR_CODES.LEDGER_WRITE_FAILED, 'Ledger write failed');
      });

      try {
        await service.intake('test-candidate-001');
      } catch (err: unknown) {
        expectCandidateError(err, INTAKE_ERROR_CODES.LEDGER_WRITE_FAILED);
      }
    });

    it('throws LEDGER_WRITE_FAILED when adapter throws generic error', async () => {
      const candidate = createCandidate();
      const artifact = createArtifact();
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(artifact);
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation(() => {
        throw new Error('disk full');
      });

      try {
        await service.intake('test-candidate-001');
      } catch (err: unknown) {
        expectCandidateError(err, INTAKE_ERROR_CODES.LEDGER_WRITE_FAILED);
      }
    });

    it('throws INPUT_INVALID for empty string', async () => {
      try {
        await service.intake('');
      } catch (err: unknown) {
        expectCandidateError(err, INTAKE_ERROR_CODES.INPUT_INVALID);
      }
    });

    it('throws INPUT_INVALID for non-string input', async () => {
      // @ts-expect-error - testing invalid input
      try {
        await service.intake(null as unknown as string);
      } catch (err: unknown) {
        expectCandidateError(err, INTAKE_ERROR_CODES.INPUT_INVALID);
      }
    });

    it('candidate stays pending on ALL error paths (E-01)', async () => {
      // Test CANDIDATE_NOT_FOUND
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(null);
      try { await service.intake('test-candidate-001'); } catch { /* expected */ }
      expect(mockStateManager.updateCandidateStatus).not.toHaveBeenCalled();
      vi.mocked(mockStateManager.getCandidate).mockClear();

      // Test ARTIFACT_NOT_FOUND
      const candidate = createCandidate();
      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(null);
      try { await service.intake('test-candidate-001'); } catch { /* expected */ }
      expect(mockStateManager.updateCandidateStatus).not.toHaveBeenCalled();
      vi.mocked(mockStateManager.getArtifact).mockClear();

      // Test LEDGER_WRITE_FAILED
      const artifact = createArtifact();
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);
      vi.mocked(mockLedgerAdapter.writeProbationEntry).mockImplementation(() => {
        throw new Error('disk full');
      });
      try { await service.intake('test-candidate-001'); } catch { /* expected */ }
      expect(mockStateManager.updateCandidateStatus).not.toHaveBeenCalled();
    });
  });

  // ── Built entry field validation (E-06) ───────────────────────

  describe('built entry field validation', () => {
    it('sourceRef format is candidate://<id> (D-11)', async () => {
      const candidate = createCandidate({ candidateId: 'my-special-candidate' });
      const artifact = createArtifact();

      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(artifact);

      let capturedEntry: LedgerPrincipleEntry | null = null;
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation((e: LedgerPrincipleEntry) => {
        capturedEntry = e;
        return e;
      });

      await service.intake('my-special-candidate');

      expect(capturedEntry!.sourceRef).toBe('candidate://my-special-candidate');
    });

    it('artifactRef is artifact://<artifactId>', async () => {
      const candidate = createCandidate({ candidateId: 'c001', artifactId: 'art-001' });
      const artifact = createArtifact({ artifactId: 'art-001' });

      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(artifact);

      let capturedEntry: LedgerPrincipleEntry | null = null;
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation((e: LedgerPrincipleEntry) => {
        capturedEntry = e;
        return e;
      });

      await service.intake('c001');

      expect(capturedEntry!.artifactRef).toBe('artifact://art-001');
    });

    it('handles minimal artifact without triggerPattern/action', async () => {
      const candidate = createCandidate();
      const minimalArtifact = createArtifact({
        contentJson: JSON.stringify({
          recommendation: {
            title: 'Test',
            text: 'Test text',
          },
        }),
      });

      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(minimalArtifact);

      let capturedEntry: LedgerPrincipleEntry | null = null;
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation((e: LedgerPrincipleEntry) => {
        capturedEntry = e;
        return e;
      });

      await service.intake('test-candidate-001');

      expect(capturedEntry!.triggerPattern).toBeUndefined();
      expect(capturedEntry!.action).toBeUndefined();
    });

    it('uses description as fallback for text when recommendation text is empty', async () => {
      const candidate = createCandidate({ description: 'Fallback description text' });
      const artifact = createArtifact({
        contentJson: JSON.stringify({
          recommendation: {
            title: 'Test',
            text: '',
          },
        }),
      });

      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(artifact);

      let capturedEntry: LedgerPrincipleEntry | null = null;
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation((e: LedgerPrincipleEntry) => {
        capturedEntry = e;
        return e;
      });

      await service.intake('test-candidate-001');

      expect(capturedEntry!.text).toBe('Fallback description text');
    });
  });
});
