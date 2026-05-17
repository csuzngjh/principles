import { describe, it, expect, vi } from 'vitest';
import {
  computeBridgeDecision,
  buildDreamerTaskSeed,
  seedIntakeTask,
  ROUTE_CHANNEL_MAP,
} from '../internalization/intake-to-internalization-bridge.js';
import type {
  IntakeToInternalizationBridgeInput,
  BridgeTaskStore,
} from '../internalization/intake-to-internalization-bridge.js';
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

    it('implementation-candidate route maps to skill channel', () => {
      const result = computeBridgeDecision({
        candidateId: 'cand-impl',
        recommendationKind: 'implementation',
        route: 'implementation-candidate',
        ready: true,
      });
      expect(result.decision).toBe('seeded');
      if (result.decision === 'seeded') {
        expect(result.channel).toBe('skill');
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
      if (!('decision' in result)) {
        expect(result.taskId).toBe('dreamer-cand-001-prompt');
        expect(result.taskKind).toBe('dreamer');
        expect(result.channel).toBe('prompt');
        expect(result.status).toBe('pending');
        expect(result.attemptCount).toBe(0);
        expect(result.maxAttempts).toBe(3);
      }
    });

    it('returns BridgeDecision for invalid input', () => {
      const result = buildDreamerTaskSeed({
        ...validInput,
        candidateId: '',
      });
      if ('decision' in result) {
        expect(result.decision).toBe('invalid_candidate');
      }
    });

    it('returns BridgeDecision for not-ready input', () => {
      const result = buildDreamerTaskSeed({
        ...validInput,
        ready: false,
      });
      if ('decision' in result) {
        expect(result.decision).toBe('not_internalizable');
      }
    });

    it('created task metadata can be parsed by parsePITaskMetadata', () => {
      const result = buildDreamerTaskSeed(validInput);
      if ('diagnosticJson' in result) {
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
      }
    });

    it('diagnosticJson contains top-level candidateId for chain integrity', () => {
      const result = buildDreamerTaskSeed(validInput);
      if ('diagnosticJson' in result) {
        const diagObj = JSON.parse(result.diagnosticJson);
        expect(diagObj.candidateId).toBe('cand-001');
      }
    });

    it('dependencyTaskIds is empty, channel is correct, taskKind is dreamer', () => {
      const result = buildDreamerTaskSeed(validInput);
      if ('diagnosticJson' in result) {
        const meta = parsePITaskMetadata(result.diagnosticJson);
        if (meta) {
          expect(meta.dependencyTaskIds).toEqual([]);
          expect(meta.channel).toBe('prompt');
        }
        expect(result.taskKind).toBe('dreamer');
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
});
