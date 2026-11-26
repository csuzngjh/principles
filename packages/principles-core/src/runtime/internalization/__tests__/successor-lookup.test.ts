import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { lookupSuccessorByParent } from '../successor-lookup.js';
import { PI_METADATA_KEY } from '../pitask-metadata.js';
import { PD_TASK_STATUSES } from '../../task-status.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-successor-lookup-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
});

afterEach(async () => {
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

// eslint-disable-next-line @typescript-eslint/max-params -- fixture shape follows neighboring internalization integration tests
async function mkTask(taskId: string, taskKind: string, parentTaskId?: string, channel = 'prompt'): Promise<void> {
  await stateManager.createTask({
    taskId,
    taskKind,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: JSON.stringify({
      [PI_METADATA_KEY]: {
        dependencyTaskIds: parentTaskId !== undefined ? [parentTaskId] : [],
        channel,
        timeoutMs: 300000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        ...(parentTaskId !== undefined ? { parentTaskId } : {}),
      },
    }),
  });
}

async function lookup(parentTaskId = 'parent-a', successorKind: 'evaluator' | 'scribe' = 'evaluator', channel: 'prompt' | 'skill' = 'prompt') {
  return lookupSuccessorByParent(stateManager, { parentTaskId, successorKind, channel });
}

describe('lookupSuccessorByParent', () => {
  it('returns none when no successor matches', async () => {
    await mkTask('parent-a', 'artificer');
    expect((await lookup()).outcome).toBe('none');
  });

  it('returns the unique successor for exact parent/kind/channel', async () => {
    await mkTask('successor-1', 'evaluator', 'parent-a');
    const result = await lookup();
    expect(result.outcome).toBe('unique');
    if (result.outcome === 'unique') expect(result.successor.taskId).toBe('successor-1');
  });

  it('fails closed with all ids for two or three successors instead of selecting one', async () => {
    await mkTask('z-deterministic', 'evaluator', 'parent-a');
    await mkTask('a-timestamped', 'evaluator', 'parent-a');
    await mkTask('m-third', 'evaluator', 'parent-a');
    const result = await lookup();
    expect(result.outcome).toBe('conflict');
    if (result.outcome === 'conflict') {
      expect(result.conflictingSuccessorTaskIds).toEqual(['a-timestamped', 'm-third', 'z-deterministic']);
      expect(result.conflictingSuccessors).toHaveLength(3);
      expect(result.decision).toBe('successor_integrity_conflict');
      expect(result.reason).toBe('multiple_successors_for_parent');
      expect(result.detail).toBe('parentTaskId=parent-a;successorKind=evaluator;channel=prompt;taskIds=[a-timestamped,m-third,z-deterministic]');
      expect(result.parentTaskId).toBe('parent-a');
      expect(result.successorKind).toBe('evaluator');
      expect(result.channel).toBe('prompt');
    }
  });

  it('pushes exact parent/kind/channel candidate narrowing into TaskStore', async () => {
    await mkTask('successor-pushdown', 'evaluator', 'parent-a');
    const originalListTasks = stateManager.listTasks.bind(stateManager);
    const filters: unknown[] = [];
    stateManager.listTasks = async (filter?: Parameters<RuntimeStateManager['listTasks']>[0]) => {
      filters.push(filter);
      return originalListTasks(filter);
    };
    try {
      const result = await lookup();
      expect(result.outcome).toBe('unique');
    } finally {
      stateManager.listTasks = originalListTasks;
    }
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({
      taskKind: 'evaluator',
      piParentTaskId: 'parent-a',
      piChannel: 'prompt',
    });
    expect((filters[0] as { statuses?: readonly string[] }).statuses).toEqual([...PD_TASK_STATUSES]);
  });

  it('deterministic-id and timestamp-id duplicates form one integrity conflict', async () => {
    await mkTask('evaluator-candidate-prompt', 'evaluator', 'parent-a');
    await mkTask('evaluator-candidate-prompt-1730000000000', 'evaluator', 'parent-a');
    const result = await lookup();
    expect(result.outcome).toBe('conflict');
    if (result.outcome === 'conflict') {
      expect(result.conflictingSuccessorTaskIds).toEqual([
        'evaluator-candidate-prompt',
        'evaluator-candidate-prompt-1730000000000',
      ]);
    }
  });

  it('different channel, kind, or parent does not conflict', async () => {
    await mkTask('same-triple', 'evaluator', 'parent-a', 'prompt');
    await mkTask('other-channel', 'evaluator', 'parent-a', 'skill');
    await mkTask('other-kind', 'scribe', 'parent-a', 'prompt');
    await mkTask('other-parent', 'evaluator', 'parent-b', 'prompt');
    const result = await lookup();
    expect(result.outcome).toBe('unique');
    if (result.outcome === 'unique') expect(result.successor.taskId).toBe('same-triple');
  });
});
