/**
 * Tests for CandidateIntakeService content shape extraction — 3 historical shapes.
 *
 * Shapes tested:
 *   1. { recommendation: {...} }  — manual E2E wrapper
 *   2. DiagnosticianOutputV1      — { summary, rootCause, recommendations: [...] }
 *   3. bare Recommendation-like object
 *
 * Also tests:
 *   - Diagnostician recommendation normalization (description → text)
 *   - sourceRecommendationJson canonical source vs contentJson fallback
 *   - Malformed JSON handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CandidateIntakeService } from '../../src/runtime-v2/candidate-intake-service.js';
import { CandidateIntakeError, INTAKE_ERROR_CODES } from '../../src/runtime-v2/candidate-intake.js';
import type { LedgerPrincipleEntry, LedgerAdapter } from '../../src/runtime-v2/candidate-intake.js';
import type { RuntimeStateManager } from '../../src/runtime-v2/store/runtime-state-manager.js';

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

describe('CandidateIntakeService — content shape extraction', () => {
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
    vi.spyOn(mockLedgerAdapter, 'existsForCandidate').mockReturnValue(null);
    vi.spyOn(mockLedgerAdapter, 'writeProbationEntry').mockImplementation((e: LedgerPrincipleEntry) => e);
  });

  // ── Shape 1: { recommendation: {...} } wrapper ─────────────

  describe('shape 1: recommendation wrapper', () => {
    it('extracts recommendation from { recommendation: {...} } wrapper', async () => {
      const candidate = {
        candidateId: 'shape1-001',
        artifactId: 'art-001',
        taskId: 'task-001',
        title: 'Shape 1 test',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-001',
        contentJson: JSON.stringify({
          recommendation: {
            title: 'Shape 1 title',
            text: 'Shape 1 text body',
            triggerPattern: 'shape1.*pattern',
            action: 'shape1 action',
          },
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('shape1-001');

      expect(result.title).toBe('Shape 1 test');
      expect(result.text).toBe('Shape 1 text body');
      expect(result.triggerPattern).toBe('shape1.*pattern');
      expect(result.action).toBe('shape1 action');
    });

    it('handles recommendation wrapper with only text field', async () => {
      const candidate = {
        candidateId: 'shape1-minimal',
        artifactId: 'art-002',
        taskId: 'task-002',
        title: 'Minimal shape 1',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-002',
        contentJson: JSON.stringify({
          recommendation: {
            text: 'Only text field',
          },
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('shape1-minimal');
      expect(result.text).toBe('Only text field');
    });
  });

  // ── Shape 2: DiagnosticianOutputV1 with recommendations[] ──

  describe('shape 2: DiagnosticianOutputV1 with recommendations array', () => {
    it('extracts first recommendation from recommendations[] array', async () => {
      const candidate = {
        candidateId: 'shape2-001',
        artifactId: 'art-003',
        taskId: 'task-003',
        title: 'Shape 2 test',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-003',
        contentJson: JSON.stringify({
          summary: 'Diagnostician summary',
          rootCause: 'Root cause analysis',
          recommendations: [
            {
              title: 'First recommendation',
              text: 'First rec text body',
              triggerPattern: 'shape2.*pattern',
              action: 'shape2 action',
            },
            {
              title: 'Second recommendation',
              text: 'Second rec text',
            },
          ],
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('shape2-001');

      expect(result.title).toBe('Shape 2 test');
      expect(result.text).toBe('First rec text body');
      expect(result.triggerPattern).toBe('shape2.*pattern');
      expect(result.action).toBe('shape2 action');
    });

    it('handles empty recommendations array (falls through)', async () => {
      const candidate = {
        candidateId: 'shape2-empty',
        artifactId: 'art-004',
        taskId: 'task-004',
        title: 'Empty recommendations',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-004',
        contentJson: JSON.stringify({
          summary: 'Summary with no recs',
          rootCause: 'Root cause',
          recommendations: [],
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      try {
        await service.intake('shape2-empty');
        throw new Error('expected INPUT_INVALID');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(CandidateIntakeError);
        expect((err as CandidateIntakeError).code).toBe(INTAKE_ERROR_CODES.INPUT_INVALID);
      }
    });

    it('normalizes diagnostician recommendation with description field (description → text)', async () => {
      const candidate = {
        candidateId: 'shape2-desc',
        artifactId: 'art-005',
        taskId: 'task-005',
        title: 'Description normalization test',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-005',
        contentJson: JSON.stringify({
          summary: 'Diagnostician output',
          recommendations: [
            {
              description: 'This is the description body (diagnostician uses description not text)',
            },
          ],
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('shape2-desc');
      expect(result.text).toBe('This is the description body (diagnostician uses description not text)');
    });

    it('normalizes description field in recommendation wrapper (shape 1 + description)', async () => {
      const candidate = {
        candidateId: 'shape1-desc',
        artifactId: 'art-006',
        taskId: 'task-006',
        title: 'Shape 1 + description',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-006',
        contentJson: JSON.stringify({
          recommendation: {
            description: 'Description in shape 1 wrapper',
          },
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('shape1-desc');
      expect(result.text).toBe('Description in shape 1 wrapper');
    });
  });

  // ── Shape 3: bare Recommendation-like object ──────────────

  describe('shape 3: bare recommendation object', () => {
    it('extracts recommendation from bare object (no wrapper)', async () => {
      const candidate = {
        candidateId: 'shape3-001',
        artifactId: 'art-007',
        taskId: 'task-007',
        title: 'Shape 3 test',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-007',
        contentJson: JSON.stringify({
          title: 'Bare rec title',
          text: 'Bare rec text body',
          triggerPattern: 'bare.*pattern',
          action: 'bare action',
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('shape3-001');
      expect(result.title).toBe('Shape 3 test');
      expect(result.text).toBe('Bare rec text body');
      expect(result.triggerPattern).toBe('bare.*pattern');
      expect(result.action).toBe('bare action');
    });

    it('normalizes description field in bare object', async () => {
      const candidate = {
        candidateId: 'shape3-desc',
        artifactId: 'art-008',
        taskId: 'task-008',
        title: 'Bare description',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-008',
        contentJson: JSON.stringify({
          description: 'Bare object with description field',
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('shape3-desc');
      expect(result.text).toBe('Bare object with description field');
    });
  });

  // ── sourceRecommendationJson canonical source ────────────────

  describe('sourceRecommendationJson canonical source', () => {
    it('prefers sourceRecommendationJson over contentJson when both are valid', async () => {
      const candidate = {
        candidateId: 'src-prefer-src',
        artifactId: 'art-009',
        taskId: 'task-009',
        title: 'Source preference test',
        description: 'Fallback description',
        sourceRecommendationJson: JSON.stringify({
          text: 'From sourceRecommendationJson',
          triggerPattern: 'src-pattern',
          action: 'src action',
        }),
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-009',
        contentJson: JSON.stringify({
          recommendation: {
            text: 'From contentJson (should be ignored)',
            triggerPattern: 'artifact-pattern',
          },
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('src-prefer-src');
      expect(result.text).toBe('From sourceRecommendationJson');
      expect(result.triggerPattern).toBe('src-pattern');
      expect(result.action).toBe('src action');
    });

    it('falls back to contentJson when sourceRecommendationJson is empty', async () => {
      const candidate = {
        candidateId: 'src-empty-fallback',
        artifactId: 'art-010',
        taskId: 'task-010',
        title: 'Empty source fallback',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-010',
        contentJson: JSON.stringify({
          recommendation: {
            text: 'Fell back to contentJson',
          },
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('src-empty-fallback');
      expect(result.text).toBe('Fell back to contentJson');
    });

    it('falls back to contentJson when sourceRecommendationJson is malformed JSON', async () => {
      const candidate = {
        candidateId: 'src-malformed-fallback',
        artifactId: 'art-011',
        taskId: 'task-011',
        title: 'Malformed source fallback',
        description: 'Fallback description',
        sourceRecommendationJson: '{invalid json!!!',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-011',
        contentJson: JSON.stringify({
          recommendation: {
            text: 'Fell back after malformed source',
          },
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('src-malformed-fallback');
      expect(result.text).toBe('Fell back after malformed source');
    });

    it('normalizes description field in sourceRecommendationJson', async () => {
      const candidate = {
        candidateId: 'src-desc-norm',
        artifactId: 'art-012',
        taskId: 'task-012',
        title: 'Source description normalization',
        description: 'Fallback description',
        sourceRecommendationJson: JSON.stringify({
          description: 'Description from source with description only',
        }),
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-012',
        contentJson: JSON.stringify({
          recommendation: {
            text: 'Should not be used',
          },
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      const result = await service.intake('src-desc-norm');
      expect(result.text).toBe('Description from source with description only');
    });
  });

  // ── Error cases ───────────────────────────────────────────────

  describe('error cases', () => {
    it('throws INPUT_INVALID when contentJson is valid JSON but has no recognizable recommendation shape', async () => {
      const candidate = {
        candidateId: 'err-no-shape',
        artifactId: 'art-err1',
        taskId: 'task-err1',
        title: 'No shape test',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-err1',
        contentJson: JSON.stringify({ foo: 'bar', baz: 42 }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      try {
        await service.intake('err-no-shape');
        throw new Error('expected INPUT_INVALID');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(CandidateIntakeError);
        expect((err as CandidateIntakeError).code).toBe(INTAKE_ERROR_CODES.INPUT_INVALID);
      }
    });

    it('throws INPUT_INVALID when recommendations array items have no recognized fields', async () => {
      const candidate = {
        candidateId: 'err-empty-recs',
        artifactId: 'art-err2',
        taskId: 'task-err2',
        title: 'Empty rec items',
        description: 'Fallback description',
        sourceRecommendationJson: '',
        status: 'pending' as const,
        createdAt: '2026-04-26T10:00:00.000Z',
      };
      const artifact = {
        artifactId: 'art-err2',
        contentJson: JSON.stringify({
          recommendations: [
            { notAField: 'nothing recognizable' },
          ],
        }),
      };

      vi.mocked(mockStateManager.getCandidate).mockResolvedValue(candidate);
      vi.mocked(mockStateManager.getArtifact).mockResolvedValue(artifact);

      try {
        await service.intake('err-empty-recs');
        throw new Error('expected INPUT_INVALID');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(CandidateIntakeError);
        expect((err as CandidateIntakeError).code).toBe(INTAKE_ERROR_CODES.INPUT_INVALID);
      }
    });
  });
});
