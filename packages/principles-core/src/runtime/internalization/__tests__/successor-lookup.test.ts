import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { MemoryTaskStore } from '../../store/task/memory-task-store.js';
import { lookupSuccessorByParent } from '../successor-lookup.js';
import { createLogicalSuccessorTask } from '../successor-create.js';
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
    expect(filters).toHaveLength(2);
    expect(filters[0]).toMatchObject({
      taskKind: 'evaluator',
      piParentTaskId: 'parent-a',
      piChannel: 'prompt',
    });
    expect((filters[0] as { statuses?: readonly string[] }).statuses).toEqual([...PD_TASK_STATUSES]);
    expect(filters[1]).toMatchObject({ taskKind: 'evaluator' });
    expect((filters[1] as { piParentTaskId?: string }).piParentTaskId).toBeUndefined();
    expect((filters[1] as { piChannel?: string }).piChannel).toBeUndefined();
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


describe('malformed successor metadata fail-closed behavior', () => {
  it('identity-valid but non-identity-corrupt metadata is malformed, never none', async () => {
    await stateManager.createTask({
      taskId: 'eval-corrupt-nonidentity', taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        [PI_METADATA_KEY]: {
          dependencyTaskIds: 'not-an-array', channel: 'prompt', timeoutMs: 300000,
          inputArtifactRefs: [], outputArtifactRefs: [], parentTaskId: 'parent-a',
        },
      }),
    });
    const result = await lookup();
    expect(result.outcome).toBe('malformed');
    if (result.outcome === 'malformed') {
      expect(result.malformedCandidateTaskIds).toEqual(['eval-corrupt-nonidentity']);
      expect(result.nextAction).toBe('repair_malformed_successor_metadata_before_retry');
    }
  });

  it('pi_metadata with parent but missing channel is fail-closed malformed', async () => {
    await stateManager.createTask({
      taskId: 'eval-missing-channel', taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        [PI_METADATA_KEY]: {
          dependencyTaskIds: ['parent-a'], timeoutMs: 300000,
          inputArtifactRefs: [], outputArtifactRefs: [], parentTaskId: 'parent-a',
        },
      }),
    });
    const result = await lookup();
    expect(result.outcome).toBe('malformed');
    if (result.outcome === 'malformed') expect(result.malformedCandidateTaskIds).toEqual(['eval-missing-channel']);
  });


  it('valid successor plus same-parent missing-channel malformed successor is malformed', async () => {
    await mkTask('eval-valid-mixed', 'evaluator', 'parent-a');
    await stateManager.createTask({
      taskId: 'eval-missing-channel-mixed', taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        [PI_METADATA_KEY]: {
          dependencyTaskIds: ['parent-a'], timeoutMs: 300000,
          inputArtifactRefs: [], outputArtifactRefs: [], parentTaskId: 'parent-a',
        },
      }),
    });
    const result = await lookup();
    expect(result.outcome).toBe('malformed');
    if (result.outcome === 'malformed') expect(result.malformedCandidateTaskIds).toEqual(['eval-missing-channel-mixed']);
  });

  it('valid successor plus same-channel missing-parent malformed candidate is fail-closed', async () => {
    await mkTask('eval-valid-missing-parent-mixed', 'evaluator', 'parent-a');
    await stateManager.createTask({
      taskId: 'eval-missing-parent-malformed', taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        [PI_METADATA_KEY]: {
          dependencyTaskIds: 'broken', channel: 'prompt', timeoutMs: 300000,
          inputArtifactRefs: [], outputArtifactRefs: [],
        },
      }),
    });
    const result = await lookup();
    expect(result.outcome).toBe('malformed');
    if (result.outcome === 'malformed') expect(result.malformedCandidateTaskIds).toEqual(['eval-missing-parent-malformed']);
  });

  it('valid successor plus unrelated malformed task remains unique', async () => {
    await mkTask('eval-valid-unrelated', 'evaluator', 'parent-a');
    await stateManager.createTask({
      taskId: 'eval-unrelated-malformed', taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        [PI_METADATA_KEY]: {
          dependencyTaskIds: ['parent-z'], timeoutMs: 300000,
          inputArtifactRefs: [], outputArtifactRefs: [], parentTaskId: 'parent-z',
        },
      }),
    });
    const result = await lookup();
    expect(result.outcome).toBe('unique');
    if (result.outcome === 'unique') expect(result.successor.taskId).toBe('eval-valid-unrelated');
  });

  it('valid successor plus identity-valid non-identity-corrupt successor is malformed', async () => {
    await mkTask('eval-valid-corrupt-mixed', 'evaluator', 'parent-a');
    await stateManager.createTask({
      taskId: 'eval-corrupt-nonidentity-mixed', taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        [PI_METADATA_KEY]: {
          dependencyTaskIds: 'broken', channel: 'prompt', timeoutMs: 300000,
          inputArtifactRefs: [], outputArtifactRefs: [], parentTaskId: 'parent-a',
        },
      }),
    });
    const result = await lookup();
    expect(result.outcome).toBe('malformed');
    if (result.outcome === 'malformed') expect(result.malformedCandidateTaskIds).toEqual(['eval-corrupt-nonidentity-mixed']);
  });
});

describe('createLogicalSuccessorTask atomic arbitration', () => {
  it('two independent SQLite connections cannot create duplicate logical successors', async () => {
    const second = new RuntimeStateManager({ workspaceDir });
    await second.initialize();
    try {
      await mkTask('parent-atomic', 'artificer');
      const metadata = {
        dependencyTaskIds: ['parent-atomic'], channel: 'prompt' as const, timeoutMs: 300000,
        inputArtifactRefs: [], outputArtifactRefs: [], parentTaskId: 'parent-atomic',
      };
      const [a, b] = await Promise.all([
        createLogicalSuccessorTask({
          stateManager, parentTaskId: 'parent-atomic', successorKind: 'evaluator', channel: 'prompt',
          preferredTaskId: 'evaluator-deterministic', metadata,
        }),
        createLogicalSuccessorTask({
          stateManager: second, parentTaskId: 'parent-atomic', successorKind: 'evaluator', channel: 'prompt',
          preferredTaskId: 'evaluator-timestamp-abc', metadata,
        }),
      ]);
      expect([a.outcome, b.outcome].sort()).toEqual(['created', 'existing']);
      const created = a.outcome === 'created' ? a.task : b.outcome === 'created' ? b.task : null;
      const existing = a.outcome === 'existing' ? a.task : b.outcome === 'existing' ? b.task : null;
      expect(created?.taskId).toBe(existing?.taskId);
      const rows = await stateManager.listTasks({ taskKind: 'evaluator', piParentTaskId: 'parent-atomic', piChannel: 'prompt' });
      expect(rows).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it('two concurrent creations on the same RuntimeStateManager are serialized', async () => {
    await mkTask('parent-same-manager', 'artificer');
    const metadata = {
      dependencyTaskIds: ['parent-same-manager'], channel: 'prompt' as const, timeoutMs: 300000,
      inputArtifactRefs: [], outputArtifactRefs: [], parentTaskId: 'parent-same-manager',
    };
    const originalListTasks = stateManager.listTasks.bind(stateManager);
    let firstLookupStarted!: () => void;
    let releaseFirstLookup!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstLookupStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirstLookup = resolve; });
    let intercepted = 0;
    stateManager.listTasks = async (filter?: Parameters<RuntimeStateManager['listTasks']>[0]) => {
      if (filter?.taskKind === 'evaluator') {
        intercepted += 1;
        if (intercepted === 1) {
          firstLookupStarted();
          await firstGate;
        }
      }
      return originalListTasks(filter);
    };
    try {
      const first = createLogicalSuccessorTask({
        stateManager, parentTaskId: 'parent-same-manager', successorKind: 'evaluator', channel: 'prompt',
        preferredTaskId: 'evaluator-same-manager-deterministic', metadata,
      });
      await firstStarted;
      const second = createLogicalSuccessorTask({
        stateManager, parentTaskId: 'parent-same-manager', successorKind: 'evaluator', channel: 'prompt',
        preferredTaskId: 'evaluator-same-manager-timestamp', metadata,
      });
      releaseFirstLookup();
      const [a, b] = await Promise.all([first, second]);
      expect([a.outcome, b.outcome].sort()).toEqual(['created', 'existing']);
      const created = a.outcome === 'created' ? a.task : b.outcome === 'created' ? b.task : null;
      const existing = a.outcome === 'existing' ? a.task : b.outcome === 'existing' ? b.task : null;
      expect(created?.taskId).toBe(existing?.taskId);
      const rows = await stateManager.listTasks({ taskKind: 'evaluator', piParentTaskId: 'parent-same-manager', piChannel: 'prompt' });
      expect(rows).toHaveLength(1);
    } finally {
      releaseFirstLookup();
      stateManager.listTasks = originalListTasks;
    }
  });

  it('BEGIN failure does not poison later transactions on the same SQLite store', async () => {
    await mkTask('parent-begin-failure', 'artificer');
    const metadata = {
      dependencyTaskIds: ['parent-begin-failure'], channel: 'prompt' as const, timeoutMs: 300000,
      inputArtifactRefs: [], outputArtifactRefs: [], parentTaskId: 'parent-begin-failure',
    };
    const db = stateManager.connection.getDb();
    const originalPrepare = db.prepare.bind(db);
    let beginAttempts = 0;
    const mutableDb = db as unknown as { prepare: typeof db.prepare };
    mutableDb.prepare = ((sql: string, ...params: unknown[]) => {
      if (sql === 'BEGIN IMMEDIATE') beginAttempts += 1;
      return Reflect.apply(originalPrepare, db, [sql, ...params]) as ReturnType<typeof db.prepare>;
    }) as typeof db.prepare;
    try {
      db.prepare('BEGIN IMMEDIATE').run();
      await expect(createLogicalSuccessorTask({
        stateManager, parentTaskId: 'parent-begin-failure', successorKind: 'evaluator', channel: 'prompt',
        preferredTaskId: 'evaluator-after-begin-failure', metadata,
      })).rejects.toThrow();
      db.prepare('ROLLBACK').run();

      const retry = await createLogicalSuccessorTask({
        stateManager, parentTaskId: 'parent-begin-failure', successorKind: 'evaluator', channel: 'prompt',
        preferredTaskId: 'evaluator-after-begin-failure', metadata,
      });
      expect(retry.outcome).toBe('created');
      // manual outer BEGIN + failed nested BEGIN + retried BEGIN. A leaked
      // active transaction state would let the retry bypass BEGIN entirely.
      expect(beginAttempts).toBe(3);
    } finally {
      mutableDb.prepare = originalPrepare;
      if (db.inTransaction) db.prepare('ROLLBACK').run();
    }
  });

  it('MemoryTaskStore serializes independent concurrent transactions on one instance', async () => {
    const store = new MemoryTaskStore();
    const order: string[] = [];
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = store.withWriteTransaction(async () => {
      firstStarted();
      await gate;
      order.push('first');
    });
    await started;
    const second = store.withWriteTransaction(async () => {
      order.push('second');
    });
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('malformed relevant candidate blocks creation without adding a row', async () => {
    await stateManager.createTask({
      taskId: 'eval-corrupt-atomic', taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        [PI_METADATA_KEY]: {
          dependencyTaskIds: 'broken', channel: 'prompt', timeoutMs: 300000,
          inputArtifactRefs: [], outputArtifactRefs: [], parentTaskId: 'parent-atomic-malformed',
        },
      }),
    });
    const before = await stateManager.listTasks({});
    const result = await createLogicalSuccessorTask({
      stateManager, parentTaskId: 'parent-atomic-malformed', successorKind: 'evaluator', channel: 'prompt',
      preferredTaskId: 'evaluator-new-atomic',
      metadata: { dependencyTaskIds: ['parent-atomic-malformed'], channel: 'prompt', timeoutMs: 300000, inputArtifactRefs: [], outputArtifactRefs: [], parentTaskId: 'parent-atomic-malformed' },
    });
    expect(result.outcome).toBe('lookup');
    if (result.outcome === 'lookup') expect(result.lookup.outcome).toBe('malformed');
    expect((await stateManager.listTasks({})).map((t) => t.taskId)).toEqual(before.map((t) => t.taskId));
  });
});
