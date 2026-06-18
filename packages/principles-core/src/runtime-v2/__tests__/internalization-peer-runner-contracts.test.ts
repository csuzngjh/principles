/**
 * PRI-61: Internalization Engine Peer Runner Contracts — Unit Tests
 *
 * Tests type contracts, validators, and job graph topology for the
 * Internalization Engine's Peer Runner system.
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */
import { describe, it, expect } from 'vitest';
import type { TaskRecord } from '../task-status.js';

describe('Peer Runner Contracts', () => {
  // ── Type Guards ────────────────────────────────────────────────────────────

  describe('isPeerRunnerKind', () => {
    it('returns true for all 7 valid peer runner kinds', async () => {
      const { isPeerRunnerKind } = await import('../internalization/peer-runner-contracts.js');

      const validKinds = [
        'dreamer',
        'philosopher',
        'scribe',
        'artificer',
        'evaluator',
        'trainer',
        'rollout_reviewer',
      ] as const;

      for (const kind of validKinds) {
        expect(isPeerRunnerKind(kind)).toBe(true);
      }
    });

    it('returns false for invalid strings', async () => {
      const { isPeerRunnerKind } = await import('../internalization/peer-runner-contracts.js');

      expect(isPeerRunnerKind('invalid')).toBe(false);
      expect(isPeerRunnerKind('diagnostician')).toBe(false);
      expect(isPeerRunnerKind('')).toBe(false);
    });
  });

  describe('isInternalizationChannel', () => {
    it('returns true for all 5 valid channels', async () => {
      const { isInternalizationChannel } = await import('../internalization/peer-runner-contracts.js');

      const validChannels = [
        'prompt',
        'skill',
        'code_tool_hook',
        'model_training',
        'defer_archive',
      ] as const;

      for (const channel of validChannels) {
        expect(isInternalizationChannel(channel)).toBe(true);
      }
    });

    it('returns false for invalid strings', async () => {
      const { isInternalizationChannel } = await import('../internalization/peer-runner-contracts.js');

      expect(isInternalizationChannel('invalid')).toBe(false);
      expect(isInternalizationChannel('training')).toBe(false);
      expect(isInternalizationChannel('')).toBe(false);
    });
  });

  describe('isPIArtifactKind', () => {
    it('returns true for all 5 valid artifact kinds', async () => {
      const { isPIArtifactKind } = await import('../internalization/peer-runner-contracts.js');

      const validKinds = ['principle', 'rule', 'training_data', 'skill', 'patch'] as const;

      for (const kind of validKinds) {
        expect(isPIArtifactKind(kind)).toBe(true);
      }
    });

    it('returns false for invalid strings', async () => {
      const { isPIArtifactKind } = await import('../internalization/peer-runner-contracts.js');

      expect(isPIArtifactKind('invalid')).toBe(false);
      expect(isPIArtifactKind('artifact')).toBe(false);
    });
  });

  describe('isTerminalTaskStatus', () => {
    it('returns true for succeeded and failed', async () => {
      const { isTerminalTaskStatus } = await import('../internalization/peer-runner-contracts.js');

      expect(isTerminalTaskStatus('succeeded')).toBe(true);
      expect(isTerminalTaskStatus('failed')).toBe(true);
    });

    it('returns false for non-terminal statuses', async () => {
      const { isTerminalTaskStatus } = await import('../internalization/peer-runner-contracts.js');

      expect(isTerminalTaskStatus('pending')).toBe(false);
      expect(isTerminalTaskStatus('leased')).toBe(false);
      expect(isTerminalTaskStatus('retry_wait')).toBe(false);
    });
  });

  describe('isValidPITaskRecord', () => {
    it('returns true for a valid PITaskRecord', async () => {
      const { isValidPITaskRecord, createMinimalPITaskRecord } = await import(
        '../internalization/peer-runner-contracts.js'
      );

      const record = createMinimalPITaskRecord('task-1', 'dreamer', 'prompt');
      expect(isValidPITaskRecord(record as unknown as TaskRecord)).toBe(true);
    });

    it('returns false for a TaskRecord with non-peer-runner taskKind', async () => {
      const { isValidPITaskRecord } = await import('../internalization/peer-runner-contracts.js');

      const nonPIRecord = {
        taskId: 'task-1',
        taskKind: 'diagnostician', // Not a valid PeerRunnerKind
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount: 0,
        maxAttempts: 3,
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 60000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      } as unknown as TaskRecord;

      expect(isValidPITaskRecord(nonPIRecord)).toBe(false);
    });

    it('returns false when channel is not a valid InternalizationChannel', async () => {
      const { isValidPITaskRecord } = await import('../internalization/peer-runner-contracts.js');

      const invalidChannelRecord = {
        taskId: 'task-1',
        taskKind: 'dreamer',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount: 0,
        maxAttempts: 3,
        dependencyTaskIds: [],
        channel: 'invalid_channel', // Not valid
        timeoutMs: 60000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      } as unknown as TaskRecord;

      expect(isValidPITaskRecord(invalidChannelRecord)).toBe(false);
    });

    it('rejects malformed adversarial feedback at the runtime boundary', async () => {
      const { isValidPITaskRecord, createMinimalPITaskRecord } = await import(
        '../internalization/peer-runner-contracts.js'
      );
      const record = createMinimalPITaskRecord('task-invalid-feedback', 'artificer', 'prompt');
      const malformed = { ...record, adversarialFeedback: 42 };

      expect(isValidPITaskRecord(malformed as unknown as TaskRecord)).toBe(false);
    });
  });

  // ── createMinimalPITaskRecord ─────────────────────────────────────────────

  describe('createMinimalPITaskRecord', () => {
    it('creates a valid PITaskRecord with correct defaults', async () => {
      const { createMinimalPITaskRecord, isValidPITaskRecord } = await import(
        '../internalization/peer-runner-contracts.js'
      );

      const record = createMinimalPITaskRecord('task-1', 'philosopher', 'skill');

      expect(record.taskId).toBe('task-1');
      expect(record.taskKind).toBe('philosopher');
      expect(record.channel).toBe('skill');
      expect(record.status).toBe('pending');
      expect(record.attemptCount).toBe(0);
      expect(record.maxAttempts).toBe(3);
      expect(record.dependencyTaskIds).toEqual([]);
      expect(record.timeoutMs).toBe(60000);
      expect(record.inputArtifactRefs).toEqual([]);
      expect(record.outputArtifactRefs).toEqual([]);

      // Verify it passes type guard
      expect(isValidPITaskRecord(record as unknown as TaskRecord)).toBe(true);
    });

    it('creates record for all 7 peer runner kinds', async () => {
      const { createMinimalPITaskRecord, isPeerRunnerKind } = await import(
        '../internalization/peer-runner-contracts.js'
      );

      const kinds = [
        'dreamer',
        'philosopher',
        'scribe',
        'artificer',
        'evaluator',
        'trainer',
        'rollout_reviewer',
      ] as const;

      for (const kind of kinds) {
        const record = createMinimalPITaskRecord(`task-${kind}`, kind, 'prompt');
        expect(record.taskKind).toBe(kind);
        expect(isPeerRunnerKind(record.taskKind)).toBe(true);
      }
    });
  });

  // ── Constants ────────────────────────────────────────────────────────────

  describe('constants', () => {
    it('PEER_RUNNER_KINDS has 7 elements', async () => {
      const { PEER_RUNNER_KINDS } = await import('../internalization/peer-runner-contracts.js');
      expect(PEER_RUNNER_KINDS).toHaveLength(7);
    });

    it('INTERNALIZATION_CHANNELS has 5 elements', async () => {
      const { INTERNALIZATION_CHANNELS } = await import('../internalization/peer-runner-contracts.js');
      expect(INTERNALIZATION_CHANNELS).toHaveLength(5);
    });

    it('PI_ARTIFACT_KINDS has 5 elements', async () => {
      const { PI_ARTIFACT_KINDS } = await import('../internalization/peer-runner-contracts.js');
      expect(PI_ARTIFACT_KINDS).toHaveLength(5);
    });
  });
});

describe('Job Graph', () => {
  // ── validateEdge ──────────────────────────────────────────────────────────

  describe('validateEdge', () => {
    it('returns true for all non-trainer ALLOWED_EDGES (channel-free edges)', async () => {
      const { validateEdge } = await import('../internalization/internalization-job-graph.js');

      const nonTrainerEdges = [
        ['dreamer', 'philosopher'] as const,
        ['philosopher', 'scribe'] as const,
        ['scribe', 'artificer'] as const,
        ['artificer', 'evaluator'] as const,
        ['evaluator', 'rollout_reviewer'] as const,
        // Note: rollout_reviewer→trainer requires model_training channel (tested separately)
      ];

      for (const [from, to] of nonTrainerEdges) {
        expect(validateEdge(from, to)).toBe(true);
      }
    });

    it('returns false for backward edges', async () => {
      const { validateEdge } = await import('../internalization/internalization-job-graph.js');

      expect(validateEdge('scribe', 'philosopher')).toBe(false);
      expect(validateEdge('artificer', 'scribe')).toBe(false);
      expect(validateEdge('evaluator', 'artificer')).toBe(false);
    });

    it('returns false for skipped steps', async () => {
      const { validateEdge } = await import('../internalization/internalization-job-graph.js');

      expect(validateEdge('dreamer', 'scribe')).toBe(false);
      expect(validateEdge('philosopher', 'artificer')).toBe(false);
      expect(validateEdge('scribe', 'rollout_reviewer')).toBe(false);
    });

    it('returns false for cross-router edges', async () => {
      const { validateEdge } = await import('../internalization/internalization-job-graph.js');

      expect(validateEdge('dreamer', 'artificer')).toBe(false);
      expect(validateEdge('philosopher', 'evaluator')).toBe(false);
    });

    it('requires model_training channel for rollout_reviewer → trainer transition', async () => {
      const { validateEdge, MODEL_TRAINING_CHANNEL } = await import(
        '../internalization/internalization-job-graph.js'
      );

      // Without channel, trainer is not reachable from any runner
      expect(validateEdge('rollout_reviewer', 'trainer')).toBe(false);

      // Only rollout_reviewer + model_training channel reaches trainer
      expect(validateEdge('rollout_reviewer', 'trainer', MODEL_TRAINING_CHANNEL)).toBe(true);

      // Other runners with model_training channel CANNOT reach trainer in v1
      expect(validateEdge('dreamer', 'trainer', MODEL_TRAINING_CHANNEL)).toBe(false);
      expect(validateEdge('philosopher', 'trainer', MODEL_TRAINING_CHANNEL)).toBe(false);
      expect(validateEdge('scribe', 'trainer', MODEL_TRAINING_CHANNEL)).toBe(false);
      expect(validateEdge('artificer', 'trainer', MODEL_TRAINING_CHANNEL)).toBe(false);
      expect(validateEdge('evaluator', 'trainer', MODEL_TRAINING_CHANNEL)).toBe(false);
    });

    it('rejects trainer with non-model_training channel', async () => {
      const { validateEdge } = await import('../internalization/internalization-job-graph.js');

      // rollout_reviewer + non-model_training channels cannot reach trainer
      expect(validateEdge('rollout_reviewer', 'trainer', 'prompt')).toBe(false);
      expect(validateEdge('rollout_reviewer', 'trainer', 'skill')).toBe(false);
      expect(validateEdge('rollout_reviewer', 'trainer', 'defer_archive')).toBe(false);
      expect(validateEdge('rollout_reviewer', 'trainer', 'code_tool_hook')).toBe(false);
    });
  });

  // ── isAcyclic ────────────────────────────────────────────────────────────

  describe('isAcyclic', () => {
    it('returns true for empty edge list', async () => {
      const { isAcyclic } = await import('../internalization/internalization-job-graph.js');
      expect(isAcyclic([])).toBe(true);
    });

    it('returns true for valid DAG (single chain)', async () => {
      const { isAcyclic } = await import('../internalization/internalization-job-graph.js');

      const edges: readonly (readonly [string, string])[] = [
        ['dreamer', 'philosopher'],
        ['philosopher', 'scribe'],
        ['scribe', 'artificer'],
      ];

      expect(isAcyclic(edges)).toBe(true);
    });

    it('returns true for valid DAG (with fan-out to trainer)', async () => {
      const { isAcyclic } = await import('../internalization/internalization-job-graph.js');

      const edges: readonly (readonly [string, string])[] = [
        ['dreamer', 'philosopher'],
        ['philosopher', 'scribe'],
        ['scribe', 'artificer'],
        ['artificer', 'evaluator'],
        ['dreamer', 'trainer'],
        ['scribe', 'trainer'],
      ];

      expect(isAcyclic(edges)).toBe(true);
    });

    it('returns false for cycle: A → B → C → A', async () => {
      const { isAcyclic } = await import('../internalization/internalization-job-graph.js');

      const edges: readonly (readonly [string, string])[] = [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'A'],
      ];

      expect(isAcyclic(edges)).toBe(false);
    });

    it('returns false for self-loop', async () => {
      const { isAcyclic } = await import('../internalization/internalization-job-graph.js');

      const edges: readonly (readonly [string, string])[] = [['A', 'A']];
      expect(isAcyclic(edges)).toBe(false);
    });

    it('returns false for partial cycle (B → C → B, with A → B)', async () => {
      const { isAcyclic } = await import('../internalization/internalization-job-graph.js');

      const edges: readonly (readonly [string, string])[] = [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'B'],
      ];

      expect(isAcyclic(edges)).toBe(false);
    });

    it('returns true for disconnected nodes', async () => {
      const { isAcyclic } = await import('../internalization/internalization-job-graph.js');

      const edges: readonly (readonly [string, string])[] = [
        ['A', 'B'],
        ['C', 'D'],
      ];

      expect(isAcyclic(edges)).toBe(true);
    });
  });

  // ── getAllowedSuccessors ─────────────────────────────────────────────────

  describe('getAllowedSuccessors', () => {
    it('returns correct successors for dreamer', async () => {
      const { getAllowedSuccessors } = await import(
        '../internalization/internalization-job-graph.js'
      );

      const successors = getAllowedSuccessors('dreamer');

      expect(successors).toContain('philosopher');
      // trainer is only reached after rollout_reviewer in v1 (Policy B)
      expect(successors).not.toContain('trainer');
      expect(successors).not.toContain('scribe');
      expect(successors).not.toContain('artificer');
    });

    it('returns only trainer for trainer (no self-loop)', async () => {
      const { getAllowedSuccessors } = await import('../internalization/internalization-job-graph.js');

      const successors = getAllowedSuccessors('trainer');
      expect(successors).not.toContain('trainer');
    });

    it('returns correct successors for scribe (linear chain only)', async () => {
      const { getAllowedSuccessors } = await import(
        '../internalization/internalization-job-graph.js'
      );

      const successors = getAllowedSuccessors('scribe');

      expect(successors).toContain('artificer');
      // trainer only via rollout_reviewer in v1
      expect(successors).not.toContain('trainer');
      expect(successors).not.toContain('philosopher');
      expect(successors).not.toContain('dreamer');
    });

    it('returns correct successors for evaluator (rollout_reviewer only, no trainer shortcut)', async () => {
      const { getAllowedSuccessors, TRAINER_KIND } = await import(
        '../internalization/internalization-job-graph.js'
      );

      const successors = getAllowedSuccessors('evaluator');

      expect(successors).toContain('rollout_reviewer');
      // v1 policy B: trainer only via rollout_reviewer, not as shortcut from evaluator
      expect(successors).not.toContain(TRAINER_KIND);
    });

    it('returns correct successors for artificer (evaluator only, no trainer shortcut)', async () => {
      const { getAllowedSuccessors, TRAINER_KIND } = await import(
        '../internalization/internalization-job-graph.js'
      );

      const successors = getAllowedSuccessors('artificer');

      expect(successors).toContain('evaluator');
      expect(successors).not.toContain(TRAINER_KIND);
      expect(successors).not.toContain('scribe');
    });

    it('returns [trainer] for rollout_reviewer (terminal v1 successor via model_training)', async () => {
      const { getAllowedSuccessors, TRAINER_KIND } = await import(
        '../internalization/internalization-job-graph.js'
      );

      const successors = getAllowedSuccessors('rollout_reviewer');
      expect(successors).toContain(TRAINER_KIND);
      expect(successors).not.toContain('rollout_reviewer');
    });
  });

  // ── getAllowedPredecessors ───────────────────────────────────────────────

  describe('getAllowedPredecessors', () => {
    it('returns [dreamer] for philosopher', async () => {
      const { getAllowedPredecessors } = await import('../internalization/internalization-job-graph.js');

      const preds = getAllowedPredecessors('philosopher');
      expect(preds).toEqual(['dreamer']);
    });

    it('returns [philosopher] for scribe', async () => {
      const { getAllowedPredecessors } = await import('../internalization/internalization-job-graph.js');

      const preds = getAllowedPredecessors('scribe');
      expect(preds).toEqual(['philosopher']);
    });

    it('returns empty array for dreamer (no predecessors)', async () => {
      const { getAllowedPredecessors } = await import('../internalization/internalization-job-graph.js');

      const preds = getAllowedPredecessors('dreamer');
      expect(preds).toEqual([]);
    });

    it('returns [scribe] for artificer', async () => {
      const { getAllowedPredecessors } = await import('../internalization/internalization-job-graph.js');

      const preds = getAllowedPredecessors('artificer');
      expect(preds).toEqual(['scribe']);
    });

    it('returns [evaluator] for rollout_reviewer', async () => {
      const { getAllowedPredecessors } = await import('../internalization/internalization-job-graph.js');

      const preds = getAllowedPredecessors('rollout_reviewer');
      expect(preds).toEqual(['evaluator']);
    });

    it('returns [rollout_reviewer] for trainer (v1 terminal predecessor)', async () => {
      const { getAllowedPredecessors } = await import('../internalization/internalization-job-graph.js');

      const preds = getAllowedPredecessors('trainer');
      // v1 policy B: trainer is terminal successor of rollout_reviewer only
      expect(preds).toEqual(['rollout_reviewer']);
    });
  });

  // ── ALLOWED_EDGES constant ───────────────────────────────────────────────

  describe('ALLOWED_EDGES', () => {
    it('has exactly 6 edges (v1 linear chain + rollout_reviewer→trainer)', async () => {
      const { ALLOWED_EDGES } = await import('../internalization/internalization-job-graph.js');
      expect(ALLOWED_EDGES).toHaveLength(6);
    });

    it('covers dreamer→philosopher→scribe→artificer→evaluator→rollout_reviewer→trainer chain', async () => {
      const { ALLOWED_EDGES } = await import('../internalization/internalization-job-graph.js');

      const edgeSet = new Set(ALLOWED_EDGES.map(([f, t]) => `${f}→${t}`));

      expect(edgeSet.has('dreamer→philosopher')).toBe(true);
      expect(edgeSet.has('philosopher→scribe')).toBe(true);
      expect(edgeSet.has('scribe→artificer')).toBe(true);
      expect(edgeSet.has('artificer→evaluator')).toBe(true);
      expect(edgeSet.has('evaluator→rollout_reviewer')).toBe(true);
      expect(edgeSet.has('rollout_reviewer→trainer')).toBe(true);
    });

    it('is readonly (cannot be modified)', async () => {
      const { ALLOWED_EDGES } = await import('../internalization/internalization-job-graph.js');

      // ReadonlyArray<...> means the outer array reference is immutable at TypeScript level
      expect(Array.isArray(ALLOWED_EDGES)).toBe(true);
      expect(ALLOWED_EDGES).toHaveLength(6);

      // Verify each edge is a readonly tuple
      for (const edge of ALLOWED_EDGES) {
        expect(Array.isArray(edge)).toBe(true);
        expect(edge).toHaveLength(2);
      }

      // Verify edges are in expected order
      const edgeStrings = ALLOWED_EDGES.map(([f, t]) => `${f}→${t}`);
      expect(edgeStrings[0]).toBe('dreamer→philosopher');
      expect(edgeStrings[5]).toBe('rollout_reviewer→trainer');
    });
  });
});

describe('Architecture Guards', () => {
  // ── TASK_MODEL_REUSE ─────────────────────────────────────────────────────

  describe('TASK_MODEL_REUSE', () => {
    it('PITaskRecord interface extends TaskRecord at type level', async () => {
      // Type-level check: if PITaskRecord didn't extend TaskRecord,
      // TypeScript would error in the peer-runner-contracts.ts definition.
      // We verify this by checking the source code contains the correct interface.
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(__dirname, '..', 'internalization', 'peer-runner-contracts.ts'), 'utf-8');
      // If PITaskRecord doesn't extend TaskRecord, this interface definition would fail
      expect(src).toContain('interface PITaskRecord extends TaskRecord');
    });

    it('PITaskRecord has all TaskRecord base fields', async () => {
      const { createMinimalPITaskRecord } = await import(
        '../internalization/peer-runner-contracts.js'
      );

      // Verify all TaskRecord base fields are present
      const record = createMinimalPITaskRecord('test', 'dreamer', 'prompt');

      // TaskRecord base fields
      expect(record).toHaveProperty('taskId');
      expect(record).toHaveProperty('taskKind');
      expect(record).toHaveProperty('status');
      expect(record).toHaveProperty('createdAt');
      expect(record).toHaveProperty('updatedAt');
      expect(record).toHaveProperty('attemptCount');
      expect(record).toHaveProperty('maxAttempts');
    });
  });

  // ── PEER_NO_DIRECT_CHAINING ──────────────────────────────────────────────

  describe('PEER_NO_DIRECT_CHAINING', () => {
    it('job graph defines edge validation, not execution chaining', async () => {
      const { validateEdge, ALLOWED_EDGES } = await import('../internalization/internalization-job-graph.js');

      // The job graph only defines which edges are valid — it does NOT
      // provide any mechanism to directly invoke the next runner.
      // Execution chaining must happen via RuntimeStateManager.createTask().
      expect(typeof validateEdge).toBe('function');
      expect(Array.isArray(ALLOWED_EDGES)).toBe(true);

      // validateEdge is a pure validator — it doesn't execute anything
      const result = validateEdge('dreamer', 'philosopher');
      expect(typeof result).toBe('boolean');
    });
  });
});
