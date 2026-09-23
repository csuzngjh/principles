import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CandidateIntakeService } from '../../src/runtime-v2/candidate-intake-service.js';
import type { CandidateIntakeResult } from '../../src/runtime-v2/candidate-intake-service.js';
import { CandidateIntakeError, INTAKE_ERROR_CODES } from '../../src/runtime-v2/candidate-intake.js';
import type { LedgerPrincipleEntry, LedgerAdapter } from '../../src/runtime-v2/candidate-intake.js';
import type { RuntimeStateManager } from '../../src/runtime-v2/store/runtime-state-manager.js';

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
      title: 'Always verify backup before delete',
      text: 'When deleting files, always verify backup exists first for safety.',
      triggerPattern: 'file delete',
      action: 'verify backup exists',
    }),
    // Phase 1 / PR1: the Principle Ledger write boundary validates the RAW
    // persisted kind, so fixtures must declare it explicitly. Default is a
    // legitimate principle candidate; the boundary cases override it.
    recommendationKind: 'principle',
    rawRecommendationKind: 'principle',
    status: 'pending' as const,
    createdAt: '2026-04-26T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Narrow the intake result to the written/known-entry case, failing the test
 * loudly instead of silently passing on a refusal.
 */
function expectLedgerEntry(result: CandidateIntakeResult): LedgerPrincipleEntry {
  if (result.outcome !== 'ledger_entry') {
    throw new Error(`expected a ledger entry, but intake refused it: ${result.reason} — ${result.message}`);
  }
  return result.entry;
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

      expect(result.outcome).toBe('ledger_entry');
      const entry = expectLedgerEntry(result);
      expect(result.written).toBe(true);
      expect(entry).toBeDefined();
      expect(entry.title).toBe(candidate.title);
      expect(entry.sourceRef).toBe('candidate://test-candidate-001');
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

      expect(result.outcome).toBe('ledger_entry');
      // Idempotent no-op: the entry already existed, so THIS call wrote nothing.
      expect(result.outcome === 'ledger_entry' && result.written).toBe(false);
      expect(result.outcome === 'ledger_entry' && result.entry).toBe(existingEntry);
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

      const result1 = expectLedgerEntry(await service.intake('candidate-A'));
      const result2 = expectLedgerEntry(await service.intake('candidate-B'));

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

    // ── rc-1/rc-2 (ERR-001/ERR-005): reject well-formed JSON with wrong shape ──
    // Previously the service cast parsed JSON directly to Recommendation; a
    // valid-JSON-but-wrong-shape payload (e.g. `{"x":1}`) silently produced an
    // empty ledger entry. These cases pin the validateRecommendation guard.

    it('throws INPUT_INVALID when contentJson is valid JSON but wrong shape (rc-2)', async () => {
      const candidate = createCandidate({ sourceRecommendationJson: '' });
      const badArtifact = createArtifact({ contentJson: JSON.stringify({ x: 1 }) });
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(badArtifact);

      try {
        await service.intake('test-candidate-001');
        throw new Error('expected intake to throw INPUT_INVALID');
      } catch (err: unknown) {
        expectCandidateError(err, INTAKE_ERROR_CODES.INPUT_INVALID);
      }
    });

    it('throws INPUT_INVALID when contentJson is a JSON primitive (rc-2)', async () => {
      const candidate = createCandidate({ sourceRecommendationJson: '' });
      const badArtifact = createArtifact({ contentJson: '42' });
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(badArtifact);

      try {
        await service.intake('test-candidate-001');
        throw new Error('expected intake to throw INPUT_INVALID');
      } catch (err: unknown) {
        expectCandidateError(err, INTAKE_ERROR_CODES.INPUT_INVALID);
      }
    });

    it('falls back to contentJson when sourceRecommendationJson has wrong shape (rc-2)', async () => {
      // sourceRec malformed shape → null → fall through to contentJson (valid)
      const candidate = createCandidate({
        sourceRecommendationJson: JSON.stringify({ text: 123 }), // number, not string
      });
      const artifact = createArtifact(); // valid contentJson
      const written = createLedgerEntry();
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(artifact);
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockReturnValue(written);

      const result = expectLedgerEntry(await service.intake('test-candidate-001'));
      // Should succeed using the contentJson fallback (not throw).
      // The service returns the written LedgerPrincipleEntry (status 'probation'),
      // not the CandidateIntakeOutput ('consumed' is set by the CLI handler).
      expect(result.status).toBe('probation');
      expect(mockLedgerAdapter.writeProbationEntry).toHaveBeenCalled();
    });

    it('throws INPUT_INVALID when both sourceRec and contentJson have wrong shape, candidate stays pending', async () => {
      const candidate = createCandidate({
        sourceRecommendationJson: JSON.stringify({ text: 123 }), // bad shape
      });
      const badArtifact = createArtifact({ contentJson: JSON.stringify({ x: 1 }) }); // bad shape
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(badArtifact);

      try {
        await service.intake('test-candidate-001');
        throw new Error('expected intake to throw INPUT_INVALID');
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
      const candidate = createCandidate({
        sourceRecommendationJson: JSON.stringify({
          title: 'Test',
          text: 'Test text',
        }),
      });
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
      const candidate = createCandidate({
        description: 'Fallback description text',
        sourceRecommendationJson: JSON.stringify({
          title: 'Test',
          text: '',
          triggerPattern: 'test',
          action: 'do test',
        }),
      });
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

  // ── Phase 1 / PR1: Principle Ledger write boundary ────────────
  //
  // SPEC v2.1 §7 Candidate Disposition Contract. `intake()` is the single
  // shared chokepoint every candidate-origin ledger write flows through, so
  // these cases exercise the REAL entry point rather than a bare predicate.

  describe('Principle Ledger write boundary (Phase 1 / PR1)', () => {
    function arrange(overrides: Record<string, unknown>) {
      const candidate = createCandidate(overrides);
      const artifact = createArtifact();
      vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
      vi.spyOn(mockStateManager, 'getCandidate').mockResolvedValue(candidate);
      vi.spyOn(mockStateManager, 'getArtifact').mockResolvedValue(artifact);
      vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation((e: LedgerPrincipleEntry) => e);
      return candidate;
    }

    it('Case 1: principle candidate IS written to the Principle Ledger', async () => {
      arrange({ recommendationKind: 'principle', rawRecommendationKind: 'principle' });

      const result = await service.intake('test-candidate-001');

      expect(result.outcome).toBe('ledger_entry');
      expect(result.outcome === 'ledger_entry' && result.written).toBe(true);
      expect(mockLedgerAdapter.writeProbationEntry).toHaveBeenCalledOnce();
    });

    // Cases 2-4: valid kinds that do NOT target the Principle Ledger.
    for (const kind of ['rule', 'prompt', 'implementation'] as const) {
      it(`Case: ${kind} candidate is NOT written to the Principle Ledger`, async () => {
        arrange({ recommendationKind: kind, rawRecommendationKind: kind });

        const result = await service.intake('test-candidate-001');

        expect(result.outcome).toBe('refused');
        expect(result.outcome === 'refused' && result.reason).toBe('non_principle_kind');
        expect(result.outcome === 'refused' && result.rawRecommendationKind).toBe(kind);
        // Ledger untouched, and no other state mutated (persistence preserved by
        // the callers, which this service deliberately does not change).
        expect(mockLedgerAdapter.writeProbationEntry).not.toHaveBeenCalled();
        expect(mockStateManager.updateCandidateStatus).not.toHaveBeenCalled();
      });
    }

    it('Case: defer candidate is NOT written to the Principle Ledger', async () => {
      arrange({ recommendationKind: 'defer', rawRecommendationKind: 'defer' });

      const result = await service.intake('test-candidate-001');

      expect(result.outcome === 'refused' && result.reason).toBe('non_principle_kind');
      expect(mockLedgerAdapter.writeProbationEntry).not.toHaveBeenCalled();
    });

    it('Case 5: MISSING kind does NOT become a principle (fail closed)', async () => {
      const candidate = arrange({});
      delete (candidate as Record<string, unknown>).rawRecommendationKind;

      const result = await service.intake('test-candidate-001');

      expect(result.outcome).toBe('refused');
      expect(result.outcome === 'refused' && result.reason).toBe('unknown_kind');
      expect(result.outcome === 'refused' && result.rawRecommendationKind).toBeNull();
      expect(mockLedgerAdapter.writeProbationEntry).not.toHaveBeenCalled();
    });

    for (const bad of ['unknown_xyz', '', 'PRINCIPLE', 'skill'] as const) {
      it(`Case 6: INVALID kind ${JSON.stringify(bad)} does NOT become a principle`, async () => {
        arrange({ recommendationKind: bad, rawRecommendationKind: bad });

        const result = await service.intake('test-candidate-001');

        expect(result.outcome).toBe('refused');
        expect(result.outcome === 'refused' && result.reason).toBe('unknown_kind');
        expect(mockLedgerAdapter.writeProbationEntry).not.toHaveBeenCalled();
      });
    }

    it('Case 6b: NON-STRING kind does NOT become a principle', async () => {
      arrange({ recommendationKind: 42, rawRecommendationKind: 42 });

      const result = await service.intake('test-candidate-001');

      expect(result.outcome).toBe('refused');
      expect(result.outcome === 'refused' && result.reason).toBe('unknown_kind');
      expect(mockLedgerAdapter.writeProbationEntry).not.toHaveBeenCalled();
    });

    // ★ The decisive regression for this PR: the READ path normalizes unknown
    // → 'principle' (resolveRecommendationKind). A boundary that trusted that
    // normalized view would let this candidate through into the ledger, so the
    // gate MUST validate the RAW persisted value instead.
    it('guards against the fail-open normalized view leaking into the ledger', async () => {
      arrange({ recommendationKind: 'principle', rawRecommendationKind: 'unknown_xyz' });

      const result = await service.intake('test-candidate-001');

      expect(result.outcome).toBe('refused');
      expect(result.outcome === 'refused' && result.reason).toBe('unknown_kind');
      expect(mockLedgerAdapter.writeProbationEntry).not.toHaveBeenCalled();
    });
  });
});
