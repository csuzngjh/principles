import { describe, expect, it } from 'vitest';
import type { PITaskRecord, LineageRef, PIArtifact } from '../internalization/peer-runner-contracts.js';
import { createMinimalPITaskRecord } from '../internalization/peer-runner-contracts.js';

function makePITask(overrides: Partial<PITaskRecord> = {}): PITaskRecord {
  return {
    ...createMinimalPITaskRecord('test-task', 'dreamer', 'prompt'),
    ...overrides,
  };
}

function makeRejectedArtifact(sourceTaskId: string): PIArtifact {
  return {
    artifactId: 'art-1',
    artifactKind: 'principle',
    sourceTaskId,
    lineageRefs: [] as LineageRef[],
    validationStatus: 'rejected',
  };
}

describe('PRI-141: Task Three Strikes Out Mechanism', () => {
  describe('recordRejection', () => {
    it('increments rejection count from 0 to 1', async () => {
      const { recordRejection } = await import('../internalization/internalization-task-guards.js');
      const task = makePITask({ rejectionCount: 0 });
      const result = recordRejection(task);
      expect(result.rejectionCount).toBe(1);
    });

    it('increments rejection count from 1 to 2', async () => {
      const { recordRejection } = await import('../internalization/internalization-task-guards.js');
      const task = makePITask({ rejectionCount: 1 });
      const result = recordRejection(task);
      expect(result.rejectionCount).toBe(2);
    });

    it('increments rejection count from 2 to 3', async () => {
      const { recordRejection } = await import('../internalization/internalization-task-guards.js');
      const task = makePITask({ rejectionCount: 2 });
      const result = recordRejection(task);
      expect(result.rejectionCount).toBe(3);
    });

    it('is monotonic — count only increases', async () => {
      const { recordRejection } = await import('../internalization/internalization-task-guards.js');
      const task = makePITask({ rejectionCount: 5 });
      const result = recordRejection(task);
      expect(result.rejectionCount).toBe(6);
      expect(result.rejectionCount).toBeGreaterThan(task.rejectionCount);
    });

    it('preserves all other task fields', async () => {
      const { recordRejection } = await import('../internalization/internalization-task-guards.js');
      const task = makePITask({ rejectionCount: 0, taskKind: 'scribe', channel: 'code_tool_hook' });
      const result = recordRejection(task);
      expect(result.taskId).toBe(task.taskId);
      expect(result.taskKind).toBe('scribe');
      expect(result.channel).toBe('code_tool_hook');
      expect(result.rejectionCount).toBe(1);
    });
  });

  describe('isUnresolvable', () => {
    it('count 0 is not unresolvable', async () => {
      const { isUnresolvable } = await import('../internalization/internalization-task-guards.js');
      const task = makePITask({ rejectionCount: 0 });
      expect(isUnresolvable(task)).toBe(false);
    });

    it('count 1 is not unresolvable', async () => {
      const { isUnresolvable } = await import('../internalization/internalization-task-guards.js');
      const task = makePITask({ rejectionCount: 1 });
      expect(isUnresolvable(task)).toBe(false);
    });

    it('count 2 is not unresolvable', async () => {
      const { isUnresolvable } = await import('../internalization/internalization-task-guards.js');
      const task = makePITask({ rejectionCount: 2 });
      expect(isUnresolvable(task)).toBe(false);
    });

    it('count 3 IS unresolvable (default threshold)', async () => {
      const { isUnresolvable } = await import('../internalization/internalization-task-guards.js');
      const task = makePITask({ rejectionCount: 3 });
      expect(isUnresolvable(task)).toBe(true);
    });

    it('count 4 IS unresolvable', async () => {
      const { isUnresolvable } = await import('../internalization/internalization-task-guards.js');
      const task = makePITask({ rejectionCount: 4 });
      expect(isUnresolvable(task)).toBe(true);
    });

    it('custom threshold of 5: count 4 is not unresolvable, count 5 is', async () => {
      const { isUnresolvable } = await import('../internalization/internalization-task-guards.js');
      const task4 = makePITask({ rejectionCount: 4 });
      const task5 = makePITask({ rejectionCount: 5 });
      expect(isUnresolvable(task4, 5)).toBe(false);
      expect(isUnresolvable(task5, 5)).toBe(true);
    });
  });

  describe('DEFAULT_UNRESOLVABLE_THRESHOLD', () => {
    it('is 3', async () => {
      const { DEFAULT_UNRESOLVABLE_THRESHOLD } = await import('../internalization/internalization-task-guards.js');
      expect(DEFAULT_UNRESOLVABLE_THRESHOLD).toBe(3);
    });
  });

  describe('decideArtifactRejectionFeedback with three strikes', () => {
    it('scribe with rejectionCount < 3 creates corrective task', async () => {
      const { decideArtifactRejectionFeedback } = await import('../internalization/internalization-state-machine.js');
      const artifact = makeRejectedArtifact('scribe-task');
      const task = makePITask({ taskKind: 'scribe', status: 'succeeded', rejectionCount: 1 });
      const result = decideArtifactRejectionFeedback(artifact, task);
      expect(result.action).toBe('create_corrective_task');
    });

    it('scribe with rejectionCount >= 3 escalates instead of corrective task', async () => {
      const { decideArtifactRejectionFeedback } = await import('../internalization/internalization-state-machine.js');
      const artifact = makeRejectedArtifact('scribe-task');
      const task = makePITask({ taskKind: 'scribe', status: 'succeeded', rejectionCount: 3 });
      const result = decideArtifactRejectionFeedback(artifact, task);
      expect(result.action).toBe('escalate');
    });

    it('artificer with rejectionCount >= 3 escalates instead of corrective task', async () => {
      const { decideArtifactRejectionFeedback } = await import('../internalization/internalization-state-machine.js');
      const artifact = makeRejectedArtifact('artificer-task');
      const task = makePITask({ taskKind: 'artificer', status: 'succeeded', rejectionCount: 3 });
      const result = decideArtifactRejectionFeedback(artifact, task);
      expect(result.action).toBe('escalate');
    });

    it('escalation includes unresolvable reason', async () => {
      const { decideArtifactRejectionFeedback } = await import('../internalization/internalization-state-machine.js');
      const artifact = makeRejectedArtifact('scribe-task');
      const task = makePITask({ taskKind: 'scribe', status: 'succeeded', rejectionCount: 3 });
      const result = decideArtifactRejectionFeedback(artifact, task);
      if (result.action === 'escalate') {
        expect(result.rejectionReason).toContain('unresolvable');
      }
    });
  });

  describe('createNextTaskProposal with unresolvable task', () => {
    it('unresolvable task returns null even if succeeded', async () => {
      const { createNextTaskProposal } = await import('../internalization/internalization-state-machine.js');
      const task = makePITask({
        taskId: 'dreamer-1',
        taskKind: 'dreamer',
        status: 'succeeded',
        rejectionCount: 3,
        outputArtifactRefs: [{ artifactType: 'principle', ref: 'art-1' }],
      });
      const result = createNextTaskProposal(task, []);
      expect(result).toBeNull();
    });

    it('non-unresolvable succeeded task still proposes next', async () => {
      const { createNextTaskProposal } = await import('../internalization/internalization-state-machine.js');
      const task = makePITask({
        taskId: 'dreamer-1',
        taskKind: 'dreamer',
        status: 'succeeded',
        rejectionCount: 1,
        outputArtifactRefs: [{ artifactType: 'principle', ref: 'art-1' }],
      });
      const result = createNextTaskProposal(task, []);
      expect(result).not.toBeNull();
    });
  });

  describe('migration: old task without rejectionCount defaults to 0', () => {
    it('parsePITaskMetadata with missing rejectionCount defaults to 0', async () => {
      const { parsePITaskMetadata } = await import('../internalization/pitask-metadata.js');
      const oldJson = JSON.stringify({
        pi_metadata: {
          dependencyTaskIds: [],
          channel: 'prompt',
          timeoutMs: 60000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
        },
      });
      const result = parsePITaskMetadata(oldJson);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.rejectionCount).toBe(0);
      }
    });

    it('parsePITaskMetadata with explicit rejectionCount preserves value', async () => {
      const { parsePITaskMetadata } = await import('../internalization/pitask-metadata.js');
      const json = JSON.stringify({
        pi_metadata: {
          dependencyTaskIds: [],
          channel: 'prompt',
          timeoutMs: 60000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
          rejectionCount: 2,
        },
      });
      const result = parsePITaskMetadata(json);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.rejectionCount).toBe(2);
      }
    });

    it('round-trip serialize/parse preserves rejectionCount', async () => {
      const { serializePITaskMetadata, parsePITaskMetadata } = await import('../internalization/pitask-metadata.js');
      const metadata = {
        dependencyTaskIds: ['dep-1'],
        channel: 'prompt' as const,
        timeoutMs: 30000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        rejectionCount: 3,
      };
      const serialized = serializePITaskMetadata(metadata);
      const parsed = parsePITaskMetadata(serialized);
      expect(parsed).not.toBeNull();
      if (parsed) {
        expect(parsed.rejectionCount).toBe(3);
      }
    });

    it('invalid rejectionCount (negative) returns null', async () => {
      const { parsePITaskMetadata } = await import('../internalization/pitask-metadata.js');
      const json = JSON.stringify({
        pi_metadata: {
          dependencyTaskIds: [],
          channel: 'prompt',
          timeoutMs: 60000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
          rejectionCount: -1,
        },
      });
      const result = parsePITaskMetadata(json);
      expect(result).toBeNull();
    });
  });

  describe('architecture: internalization-task-guards.ts has zero infrastructure imports', () => {
    it('has no node:fs, node:path, or openclaw-plugin imports', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(__dirname, '..', 'internalization', 'internalization-task-guards.ts'), 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('openclaw-plugin');
    });
  });
});
