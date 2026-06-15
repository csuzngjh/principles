import { describe, it, expect, vi } from 'vitest';
import {
  computeBridgeDecision,
  buildDreamerTaskSeed,
  buildDreamerSeedFromCandidate,
  seedIntakeTask,
  ROUTE_CHANNEL_MAP,
  MVP_ENABLED_CHANNELS,
  CANDIDATE_KIND_TO_ROUTE,
} from '../internalization/intake-to-internalization-bridge.js';
import type {
  IntakeToInternalizationBridgeInput,
  BridgeTaskStore,
} from '../internalization/intake-to-internalization-bridge.js';
import type { CandidateRecord } from '../store/candidate/candidate-store.js';
import { parsePITaskMetadata } from '../internalization/pitask-metadata.js';
import type { InternalizationRouteKind } from '../internalization/internalization-route.js';

const validInput: IntakeToInternalizationBridgeInput = {
  candidateId: 'cand-001',
  recommendationKind: 'principle',
  route: 'principle-ledger',
  ready: true,
};

describe('IntakeToInternalizationBridge (PRI-142)', () => {
  describe('computeBridgeDecision', () => {
    it('internalizable candidate returns seeded decision', () => {
      const result = computeBridgeDecision(validInput);
      expect(result.decision).toBe('seeded');
      if (result.decision === 'seeded') {
        expect(result.taskId).toBe('dreamer-cand-001-prompt');
        expect(result.taskKind).toBe('dreamer');
        expect(result.channel).toBe('prompt');
      }
    });

    it('ready=false returns not_internalizable even with mapped route', () => {
      const result = computeBridgeDecision({
        ...validInput,
        ready: false,
      });
      expect(result.decision).toBe('not_internalizable');
      if (result.decision === 'not_internalizable') {
        expect(result.reason).toContain('not ready');
      }
    });

    it('defer route returns not_internalizable', () => {
      const result = computeBridgeDecision({
        ...validInput,
        route: 'deferred',
        recommendationKind: 'defer',
      });
      expect(result.decision).toBe('not_internalizable');
      if (result.decision === 'not_internalizable') {
        expect(result.reason).toContain('deferred');
      }
    });

    it('empty candidateId returns invalid_candidate', () => {
      const result = computeBridgeDecision({
        ...validInput,
        candidateId: '',
      });
      expect(result.decision).toBe('invalid_candidate');
    });

    it('whitespace-only candidateId returns invalid_candidate', () => {
      const result = computeBridgeDecision({
        ...validInput,
        candidateId: '   ',
      });
      expect(result.decision).toBe('invalid_candidate');
    });

    // ── PRI-355: candidateId format/length validation (recursive concatenation prevention) ──

    it('candidateId with dreamer- prefix returns invalid_candidate (PRI-355)', () => {
      const result = computeBridgeDecision({
        ...validInput,
        candidateId: 'dreamer-abc-prompt',
      });
      expect(result.decision).toBe('invalid_candidate');
      if (result.decision === 'invalid_candidate') {
        expect(result.reason).toContain('candidateId_looks_like_taskId');
      }
    });

    it('candidateId with pi-art- prefix returns invalid_candidate (PRI-355)', () => {
      const result = computeBridgeDecision({
        ...validInput,
        candidateId: 'pi-art-scribe-philosopher-dreamer-abc',
      });
      expect(result.decision).toBe('invalid_candidate');
      if (result.decision === 'invalid_candidate') {
        expect(result.reason).toContain('candidateId_looks_like_taskId');
      }
    });

    it('candidateId with scribe- prefix returns invalid_candidate (PRI-355)', () => {
      const result = computeBridgeDecision({
        ...validInput,
        candidateId: 'scribe-abc-prompt',
      });
      expect(result.decision).toBe('invalid_candidate');
      if (result.decision === 'invalid_candidate') {
        expect(result.reason).toContain('candidateId_looks_like_taskId');
      }
    });

    it('candidateId with philosopher- prefix returns invalid_candidate (PRI-355)', () => {
      const result = computeBridgeDecision({
        ...validInput,
        candidateId: 'philosopher-abc-prompt',
      });
      expect(result.decision).toBe('invalid_candidate');
      if (result.decision === 'invalid_candidate') {
        expect(result.reason).toContain('candidateId_looks_like_taskId');
      }
    });

    it('candidateId exceeding 200 characters returns invalid_candidate (PRI-355)', () => {
      const longId = 'c' + '0123456789'.repeat(20); // 201 chars
      const result = computeBridgeDecision({
        ...validInput,
        candidateId: longId,
      });
      expect(result.decision).toBe('invalid_candidate');
      if (result.decision === 'invalid_candidate') {
        expect(result.reason).toContain('candidateId_too_long');
      }
    });

    it('normal UUID candidateId passes validation (PRI-355)', () => {
      const result = computeBridgeDecision({
        ...validInput,
        candidateId: 'c2659976-c3ad-43fb-bd7c-c67dd2277669',
      });
      expect(result.decision).toBe('seeded');
      if (result.decision === 'seeded') {
        expect(result.taskId).toBe('dreamer-c2659976-c3ad-43fb-bd7c-c67dd2277669-prompt');
      }
    });

    it('unknown route returns not_internalizable', () => {
      const result = computeBridgeDecision({
        ...validInput,
        route: 'unknown-route' as InternalizationRouteKind,
      });
      expect(result.decision).toBe('not_internalizable');
    });

    it('rule-candidate route maps to code_tool_hook channel', () => {
      const result = computeBridgeDecision({
        candidateId: 'cand-rule',
        recommendationKind: 'rule',
        route: 'rule-candidate',
        ready: true,
      });
      expect(result.decision).toBe('seeded');
      if (result.decision === 'seeded') {
        expect(result.channel).toBe('code_tool_hook');
        expect(result.taskId).toBe('dreamer-cand-rule-code_tool_hook');
      }
    });

    it('implementation-candidate route returns not_internalizable (skill channel is MVP-disabled)', () => {
      const result = computeBridgeDecision({
        candidateId: 'cand-impl',
        recommendationKind: 'implementation',
        route: 'implementation-candidate',
        ready: true,
      });
      expect(result.decision).toBe('not_internalizable');
      if (result.decision === 'not_internalizable') {
        expect(result.reason).toContain('MVP-disabled');
      }
    });

    it('prompt-injection-candidate route maps to prompt channel', () => {
      const result = computeBridgeDecision({
        candidateId: 'cand-prompt',
        recommendationKind: 'prompt',
        route: 'prompt-injection-candidate',
        ready: true,
      });
      expect(result.decision).toBe('seeded');
      if (result.decision === 'seeded') {
        expect(result.channel).toBe('prompt');
      }
    });
  });

  describe('buildDreamerTaskSeed', () => {
    it('returns BridgeTaskSeed for valid input', () => {
      const result = buildDreamerTaskSeed(validInput);
      expect('decision' in result).toBe(false);
      if ('decision' in result) {
        throw new Error(`unexpected decision: ${(result as { decision: string }).decision}`);
      }
      expect(result.taskId).toBe('dreamer-cand-001-prompt');
      expect(result.taskKind).toBe('dreamer');
      expect(result.channel).toBe('prompt');
      expect(result.status).toBe('pending');
      expect(result.attemptCount).toBe(0);
      expect(result.maxAttempts).toBe(3);
    });

    it('returns BridgeDecision for invalid input', () => {
      const result = buildDreamerTaskSeed({
        ...validInput,
        candidateId: '',
      });
      expect('decision' in result).toBe(true);
      if (!('decision' in result)) {
        throw new Error('expected decision result');
      }
      expect(result.decision).toBe('invalid_candidate');
    });

    it('returns BridgeDecision for not-ready input', () => {
      const result = buildDreamerTaskSeed({
        ...validInput,
        ready: false,
      });
      expect('decision' in result).toBe(true);
      if (!('decision' in result)) {
        throw new Error('expected decision result');
      }
      expect(result.decision).toBe('not_internalizable');
    });

    it('created task metadata can be parsed by parsePITaskMetadata', () => {
      const result = buildDreamerTaskSeed(validInput);
      expect('decision' in result).toBe(false);
      if ('decision' in result) {
        throw new Error(`unexpected decision: ${(result as { decision: string }).decision}`);
      }
      const meta = parsePITaskMetadata(result.diagnosticJson);
      expect(meta).not.toBeNull();
      if (meta) {
        expect(meta.dependencyTaskIds).toEqual([]);
        expect(meta.channel).toBe('prompt');
        expect(meta.timeoutMs).toBe(300_000);
        expect(meta.inputArtifactRefs).toEqual([
          { artifactType: 'candidate', ref: 'candidate://cand-001' },
        ]);
        expect(meta.outputArtifactRefs).toEqual([]);
        expect(meta.correlationId).toBe('cand-001');
      }
    });

    it('diagnosticJson contains top-level candidateId for chain integrity', () => {
      const result = buildDreamerTaskSeed(validInput);
      expect('decision' in result).toBe(false);
      if ('decision' in result) {
        throw new Error(`unexpected decision: ${(result as { decision: string }).decision}`);
      }
      const diagObj = JSON.parse(result.diagnosticJson);
      expect(diagObj.candidateId).toBe('cand-001');
    });

    it('dependencyTaskIds is empty when no sourceTaskId provided, channel is correct, taskKind is dreamer', () => {
      const result = buildDreamerTaskSeed(validInput);
      expect('decision' in result).toBe(false);
      if ('decision' in result) {
        throw new Error(`unexpected decision: ${(result as { decision: string }).decision}`);
      }
      const meta = parsePITaskMetadata(result.diagnosticJson);
      if (meta) {
        expect(meta.dependencyTaskIds).toEqual([]);
        expect(meta.channel).toBe('prompt');
      }
      expect(result.taskKind).toBe('dreamer');
    });

    // ── PRI-395: Lineage preservation ────────────────────────────────────────

    it('populates dependencyTaskIds from sourceTaskId when provided (PRI-395)', () => {
      const input: IntakeToInternalizationBridgeInput = {
        ...validInput,
        sourceTaskId: 'diagnostician-pain-001',
        sourceArtifactId: 'artifact-001',
        sourceRunId: 'run-001',
      };
      const result = buildDreamerTaskSeed(input);
      expect('decision' in result).toBe(false);
      if ('decision' in result) throw new Error('expected seed');

      const meta = parsePITaskMetadata(result.diagnosticJson);
      expect(meta).not.toBeNull();
      if (meta) {
        expect(meta.dependencyTaskIds).toEqual(['diagnostician-pain-001']);
      }
    });

    it('populates inputArtifactRefs with diagnostician artifact when sourceArtifactId provided (PRI-395)', () => {
      const input: IntakeToInternalizationBridgeInput = {
        ...validInput,
        sourceTaskId: 'diagnostician-pain-002',
        sourceArtifactId: 'artifact-002',
      };
      const result = buildDreamerTaskSeed(input);
      expect('decision' in result).toBe(false);
      if ('decision' in result) throw new Error('expected seed');

      const meta = parsePITaskMetadata(result.diagnosticJson);
      expect(meta).not.toBeNull();
      if (meta) {
        expect(meta.inputArtifactRefs).toEqual([
          { artifactType: 'candidate', ref: 'candidate://cand-001' },
          { artifactType: 'diagnostician_output', ref: 'artifact://artifact-002' },
        ]);
      }
    });

    it('includes sourcePainId, sourceTaskId, sourceArtifactId, sourceRunId in diagnosticJson top level (PRI-395)', () => {
      const input: IntakeToInternalizationBridgeInput = {
        ...validInput,
        candidateId: 'cand-lineage-1',
        sourcePainId: 'pain-abc',
        sourceTaskId: 'diagnostician-pain-abc',
        sourceArtifactId: 'artifact-abc',
        sourceRunId: 'run-abc',
      };
      const result = buildDreamerTaskSeed(input);
      expect('decision' in result).toBe(false);
      if ('decision' in result) throw new Error('expected seed');

      const diagObj = JSON.parse(result.diagnosticJson);
      expect(diagObj.candidateId).toBe('cand-lineage-1');
      expect(diagObj.sourcePainId).toBe('pain-abc');
      expect(diagObj.sourceTaskId).toBe('diagnostician-pain-abc');
      expect(diagObj.sourceArtifactId).toBe('artifact-abc');
      expect(diagObj.sourceRunId).toBe('run-abc');
    });

    it('omits empty/whitespace lineage fields (PRI-395)', () => {
      const input: IntakeToInternalizationBridgeInput = {
        ...validInput,
        sourceTaskId: '   ',
        sourceArtifactId: '',
        sourceRunId: '   ',
      };
      const result = buildDreamerTaskSeed(input);
      expect('decision' in result).toBe(false);
      if ('decision' in result) throw new Error('expected seed');

      const meta = parsePITaskMetadata(result.diagnosticJson);
      expect(meta).not.toBeNull();
      if (meta) {
        expect(meta.dependencyTaskIds).toEqual([]);
        expect(meta.inputArtifactRefs).toEqual([
          { artifactType: 'candidate', ref: 'candidate://cand-001' },
        ]);
      }
      const diagObj = JSON.parse(result.diagnosticJson);
      expect(diagObj.sourceTaskId).toBeUndefined();
      expect(diagObj.sourceArtifactId).toBeUndefined();
      expect(diagObj.sourceRunId).toBeUndefined();
    });
  });

  describe('buildDreamerSeedFromCandidate (PRI-395)', () => {
    function makeCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
      return {
        candidateId: 'cand-99',
        artifactId: 'artifact-99',
        taskId: 'diagnostician-pain-99',
        sourceRunId: 'run-99',
        title: 'Test candidate',
        description: 'Test description',
        confidence: 0.85,
        sourceRecommendationJson: JSON.stringify({ kind: 'principle', description: 'Test' }),
        recommendationKind: 'principle',
        status: 'pending',
        createdAt: new Date().toISOString(),
        ...overrides,
      };
    }

    it('produces a dreamer seed with dependencyTaskIds from candidate.taskId', () => {
      const candidate = makeCandidate();
      const result = buildDreamerSeedFromCandidate(candidate, { route: 'principle-ledger', ready: true });
      expect('decision' in result).toBe(false);
      if ('decision' in result) throw new Error('expected seed');

      const meta = parsePITaskMetadata(result.diagnosticJson);
      expect(meta).not.toBeNull();
      if (meta) {
        expect(meta.dependencyTaskIds).toEqual(['diagnostician-pain-99']);
        expect(meta.inputArtifactRefs).toEqual([
          { artifactType: 'candidate', ref: 'candidate://cand-99' },
          { artifactType: 'diagnostician_output', ref: 'artifact://artifact-99' },
        ]);
      }
      const diagObj = JSON.parse(result.diagnosticJson);
      expect(diagObj.sourceTaskId).toBe('diagnostician-pain-99');
      expect(diagObj.sourceArtifactId).toBe('artifact-99');
      expect(diagObj.sourceRunId).toBe('run-99');
    });

    it('returns not_internalizable for an empty-taskId candidate when route is not ready', () => {
      const candidate = makeCandidate({ taskId: '', artifactId: '' });
      const result = buildDreamerSeedFromCandidate(candidate, { route: 'principle-ledger', ready: false });
      expect('decision' in result).toBe(true);
    });

    it('handles missing optional fields gracefully', () => {
      const candidate = makeCandidate({
        taskId: '',
        artifactId: '',
        sourceRunId: '',
      });
      // route is ready → seeded but with empty lineage
      const result = buildDreamerSeedFromCandidate(candidate, { route: 'principle-ledger', ready: true });
      expect('decision' in result).toBe(false);
      if ('decision' in result) throw new Error('expected seed');

      const meta = parsePITaskMetadata(result.diagnosticJson);
      expect(meta).not.toBeNull();
      if (meta) {
        expect(meta.dependencyTaskIds).toEqual([]);
        expect(meta.inputArtifactRefs).toEqual([
          { artifactType: 'candidate', ref: 'candidate://cand-99' },
        ]);
      }
    });
  });

  describe('seedIntakeTask', () => {
    const mockStore: BridgeTaskStore = {
      getTask: vi.fn().mockResolvedValue(null),
      createTask: vi.fn().mockResolvedValue({ taskId: 'dreamer-cand-001-prompt' }),
    };

    it('creates dreamer task for internalizable candidate', async () => {
      vi.clearAllMocks();
      (mockStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (mockStore.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: 'dreamer-cand-001-prompt' });

      const result = await seedIntakeTask(validInput, mockStore);
      expect(result.decision).toBe('seeded');
      if (result.decision === 'seeded') {
        expect(result.taskId).toBe('dreamer-cand-001-prompt');
        expect(result.taskKind).toBe('dreamer');
        expect(result.channel).toBe('prompt');
      }
      expect(mockStore.createTask).toHaveBeenCalledOnce();
    });

    it('returns already_exists when task already exists', async () => {
      vi.clearAllMocks();
      (mockStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: 'dreamer-cand-001-prompt' });

      const result = await seedIntakeTask(validInput, mockStore);
      expect(result.decision).toBe('already_exists');
      if (result.decision === 'already_exists') {
        expect(result.taskId).toBe('dreamer-cand-001-prompt');
      }
      expect(mockStore.createTask).not.toHaveBeenCalled();
    });

    it('returns not_internalizable for deferred route', async () => {
      vi.clearAllMocks();
      const result = await seedIntakeTask(
        { ...validInput, route: 'deferred', recommendationKind: 'defer' },
        mockStore,
      );
      expect(result.decision).toBe('not_internalizable');
      expect(mockStore.getTask).not.toHaveBeenCalled();
      expect(mockStore.createTask).not.toHaveBeenCalled();
    });

    it('returns not_internalizable for ready=false', async () => {
      vi.clearAllMocks();
      const result = await seedIntakeTask(
        { ...validInput, ready: false },
        mockStore,
      );
      expect(result.decision).toBe('not_internalizable');
      expect(mockStore.getTask).not.toHaveBeenCalled();
      expect(mockStore.createTask).not.toHaveBeenCalled();
    });

    it('returns invalid_candidate for empty candidateId', async () => {
      vi.clearAllMocks();
      const result = await seedIntakeTask(
        { ...validInput, candidateId: '' },
        mockStore,
      );
      expect(result.decision).toBe('invalid_candidate');
      expect(mockStore.getTask).not.toHaveBeenCalled();
      expect(mockStore.createTask).not.toHaveBeenCalled();
    });

    it('fails loud on store createTask error', async () => {
      vi.clearAllMocks();
      (mockStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (mockStore.createTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB write failed'));

      await expect(
        seedIntakeTask(validInput, mockStore),
      ).rejects.toThrow('DB write failed');
    });

    it('fails loud on store getTask error', async () => {
      vi.clearAllMocks();
      (mockStore.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB read failed'));

      await expect(
        seedIntakeTask(validInput, mockStore),
      ).rejects.toThrow('DB read failed');
    });

    it('returns already_exists on concurrent createTask conflict', async () => {
      vi.clearAllMocks();
      (mockStore.getTask as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ taskId: 'dreamer-cand-001-prompt' });
      (mockStore.createTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('UNIQUE constraint failed'));

      const result = await seedIntakeTask(validInput, mockStore);
      expect(result.decision).toBe('already_exists');
      if (result.decision === 'already_exists') {
        expect(result.taskId).toBe('dreamer-cand-001-prompt');
      }
    });

    it('re-throws non-concurrent createTask errors', async () => {
      vi.clearAllMocks();
      (mockStore.getTask as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      (mockStore.createTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));

      await expect(
        seedIntakeTask(validInput, mockStore),
      ).rejects.toThrow('disk full');
    });
  });

  describe('ROUTE_CHANNEL_MAP', () => {
    it('maps all four internalizable routes', () => {
      expect(ROUTE_CHANNEL_MAP['principle-ledger']).toBe('prompt');
      expect(ROUTE_CHANNEL_MAP['rule-candidate']).toBe('code_tool_hook');
      expect(ROUTE_CHANNEL_MAP['implementation-candidate']).toBe('skill');
      expect(ROUTE_CHANNEL_MAP['prompt-injection-candidate']).toBe('prompt');
    });

    it('does not map deferred route', () => {
      expect(ROUTE_CHANNEL_MAP.deferred).toBeUndefined();
    });
  });

  describe('MVP_ENABLED_CHANNELS', () => {
    it('contains prompt, code_tool_hook, defer_archive', () => {
      expect(MVP_ENABLED_CHANNELS.has('prompt')).toBe(true);
      expect(MVP_ENABLED_CHANNELS.has('code_tool_hook')).toBe(true);
      expect(MVP_ENABLED_CHANNELS.has('defer_archive')).toBe(true);
    });

    it('does not contain skill or model_training', () => {
      expect(MVP_ENABLED_CHANNELS.has('skill')).toBe(false);
      expect(MVP_ENABLED_CHANNELS.has('model_training')).toBe(false);
    });
  });

  describe('CANDIDATE_KIND_TO_ROUTE', () => {
    it('maps principle to principle-ledger', () => {
      expect(CANDIDATE_KIND_TO_ROUTE.principle).toBe('principle-ledger');
    });

    it('maps rule to rule-candidate', () => {
      expect(CANDIDATE_KIND_TO_ROUTE.rule).toBe('rule-candidate');
    });

    it('maps implementation to implementation-candidate', () => {
      expect(CANDIDATE_KIND_TO_ROUTE.implementation).toBe('implementation-candidate');
    });

    it('maps prompt to prompt-injection-candidate', () => {
      expect(CANDIDATE_KIND_TO_ROUTE.prompt).toBe('prompt-injection-candidate');
    });

    it('maps defer to deferred', () => {
      expect(CANDIDATE_KIND_TO_ROUTE.defer).toBe('deferred');
    });

    it('every mapped route exists in ROUTE_CHANNEL_MAP or is deferred', () => {
      for (const [_kind, route] of Object.entries(CANDIDATE_KIND_TO_ROUTE)) {
        if (route === 'deferred') continue;
        expect(ROUTE_CHANNEL_MAP[route]).toBeDefined();
      }
    });
  });
});
