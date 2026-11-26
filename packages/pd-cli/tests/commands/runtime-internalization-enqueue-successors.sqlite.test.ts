import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '@principles/core/runtime';
import { PI_METADATA_KEY } from '@principles/core/runtime';
import { handleRuntimeInternalizationEnqueueSuccessors } from '../../src/commands/runtime-internalization-enqueue-successors.js';

const CANDIDATE_ID = 'cand-pri1299-sqlite';
type SeedStatus = 'pending' | 'succeeded' | 'failed' | 'needs_human_review' | 'retry_wait' | 'leased';

let workspaceDir: string;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1299-enqueue-sqlite-'));
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
});

function piMetadata(meta: {
  parentTaskId?: string;
  correlationId?: string;
  dependencyTaskIds?: string[];
  runnerDecision?: string;
  revisionCount?: number;
}): string {
  return JSON.stringify({
    [PI_METADATA_KEY]: {
      dependencyTaskIds: meta.dependencyTaskIds ?? [],
      channel: 'prompt',
      pipelineMode: 'full_chain',
      timeoutMs: 300000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      ...(meta.parentTaskId !== undefined ? { parentTaskId: meta.parentTaskId } : {}),
      ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
      ...(meta.runnerDecision !== undefined ? { runnerDecision: meta.runnerDecision } : {}),
      ...(meta.revisionCount !== undefined ? { revisionCount: meta.revisionCount } : {}),
    },
  });
}

async function createTask(
  stateManager: RuntimeStateManager,
  taskId: string,
  taskKind: string,
  status: SeedStatus,
  meta: Parameters<typeof piMetadata>[0],
  topCandidateId?: string,
): Promise<void> {
  const pi = piMetadata(meta);
  const envelope = JSON.parse(pi) as Record<string, unknown>;
  if (topCandidateId !== undefined) envelope.candidateId = topCandidateId;
  await stateManager.createTask({
    taskId,
    taskKind,
    status,
    attemptCount: status === 'succeeded' ? 1 : 0,
    maxAttempts: 3,
    diagnosticJson: JSON.stringify(envelope),
  });
}

async function seedFullChain(stateManager: RuntimeStateManager, options: { artificerRevisionCount?: number } = {}): Promise<{ dreamer: string; philosopher: string; scribe: string; artificer: string }> {
  const dreamer = 'chain-dreamer';
  const philosopher = 'chain-philosopher';
  const scribe = 'chain-scribe';
  const artificer = 'chain-artificer';
  await createTask(stateManager, dreamer, 'dreamer', 'succeeded', { correlationId: CANDIDATE_ID }, CANDIDATE_ID);
  await createTask(stateManager, philosopher, 'philosopher', 'succeeded', { parentTaskId: dreamer, correlationId: CANDIDATE_ID });
  await createTask(stateManager, scribe, 'scribe', 'succeeded', { parentTaskId: philosopher, correlationId: CANDIDATE_ID });
  await createTask(stateManager, artificer, 'artificer', 'succeeded', {
    parentTaskId: scribe,
    correlationId: CANDIDATE_ID,
    dependencyTaskIds: [scribe],
    ...(options.artificerRevisionCount !== undefined ? { revisionCount: options.artificerRevisionCount } : {}),
  });
  return { dreamer, philosopher, scribe, artificer };
}

async function snapshotTasks(): Promise<{ count: number; rows: Map<string, string> }> {
  const reader = new RuntimeStateManager({ workspaceDir, readonly: true });
  await reader.initialize();
  try {
    const tasks = await reader.listTasks({});
    return {
      count: tasks.length,
      rows: new Map(tasks.map((task) => [
        task.taskId,
        [task.taskKind, task.status, String(task.attemptCount), task.diagnosticJson ?? ''].join('|'),
      ])),
    };
  } finally {
    await reader.close();
  }
}

async function seedDatabase(successorIds: { deterministicStatus: SeedStatus; timestampStatus: SeedStatus; includeTimestamp: boolean; artificerRevisionCount?: number }): Promise<{ artificer: string; deterministicId: string; timestampId: string }> {
  const writer = new RuntimeStateManager({ workspaceDir });
  await writer.initialize();
  try {
    const chain = await seedFullChain(writer, { artificerRevisionCount: successorIds.artificerRevisionCount });
    const deterministicId = 'evaluator-' + CANDIDATE_ID + '-prompt';
    const timestampId = 'evaluator-' + CANDIDATE_ID + '-prompt-1730000000000';
    await createTask(writer, deterministicId, 'evaluator', successorIds.deterministicStatus, {
      parentTaskId: chain.artificer,
      correlationId: CANDIDATE_ID,
      dependencyTaskIds: [chain.artificer],
    });
    if (successorIds.includeTimestamp) {
      await createTask(writer, timestampId, 'evaluator', successorIds.timestampStatus, {
        parentTaskId: chain.artificer,
        correlationId: CANDIDATE_ID,
        dependencyTaskIds: [chain.artificer],
      });
    }
    return { artificer: chain.artificer, deterministicId, timestampId };
  } finally {
    await writer.close();
  }
}

function readOutput(callIndex: number): {
  status: string;
  createdCount: number;
  existingCount: number;
  skippedCount: number;
  actions: Array<Record<string, unknown>>;
} {
  const call = consoleLogSpy.mock.calls[callIndex];
  expect(call, 'expected JSON output call').toBeDefined();
  return JSON.parse(String(call?.[0]));
}

function actionFor(output: { actions: Array<Record<string, unknown>> }, taskId: string): Record<string, unknown> {
  const action = output.actions.find((candidate) => candidate.taskId === taskId);
  expect(action, 'expected action for ' + taskId).toBeDefined();
  if (action === undefined) throw new Error('unreachable');
  return action;
}

describe('enqueue-successors real sqlite successor integrity integration', () => {
  it('deterministic-id plus timestamp-id duplicates fail closed identically in dry-run and confirm with zero writes', async () => {
    const seeded = await seedDatabase({ deterministicStatus: 'pending', timestampStatus: 'failed', includeTimestamp: true });
    const before = await snapshotTasks();

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, dryRun: true, json: true });
    const dryRun = readOutput(0);
    const dryAction = actionFor(dryRun, seeded.artificer);

    expect(dryRun.status).toBe('dry_run');
    expect(dryRun.skippedCount).toBe(1);
    expect(dryRun.existingCount).toBe(3);
    expect(dryAction.decision).toBe('skipped');
    expect(String(dryAction.reason)).toContain('successor_integrity_conflict');
    expect(dryAction.conflictingSuccessorTaskIds).toEqual([seeded.deterministicId, seeded.timestampId].sort());
    expect(String(dryAction.nextAction)).toContain('resolve the duplicate-chain integrity conflict');

    const afterDryRun = await snapshotTasks();
    expect(afterDryRun.count).toBe(before.count);
    expect(afterDryRun.rows).toEqual(before.rows);

    consoleLogSpy.mockClear();
    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, confirm: true, json: true });
    const confirm = readOutput(0);
    const confirmAction = actionFor(confirm, seeded.artificer);

    expect(confirm.status).toBe('confirmed');
    expect(confirm.skippedCount).toBe(1);
    expect(confirm.existingCount).toBe(3);
    expect(confirmAction.decision).toBe('skipped');
    expect(String(confirmAction.reason)).toContain('successor_integrity_conflict');
    expect(confirmAction.conflictingSuccessorTaskIds).toEqual(dryAction.conflictingSuccessorTaskIds);
    expect(confirmAction.reason).toBe(dryAction.reason);
    expect(confirmAction.nextAction).toBe(dryAction.nextAction);
    expect(String(confirmAction.reason)).toContain('multiple_successors_for_parent');

    const after = await snapshotTasks();
    expect(after.count).toBe(before.count);
    expect(after.rows).toEqual(before.rows);
    expect(after.count).toBe(6);
    expect(confirm.createdCount).toBe(0);
    expect(dryRun.createdCount).toBe(0);
    expect(actionFor(confirm, seeded.artificer).decision).not.toBe('successor_exists');
  });

  it('positive control: terminal successor plus revised source previews and performs the same cascade reopen without duplicating the row', async () => {
    const seeded = await seedDatabase({
      deterministicStatus: 'needs_human_review',
      timestampStatus: 'needs_human_review',
      includeTimestamp: false,
      artificerRevisionCount: 1,
    });
    const before = await snapshotTasks();

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, dryRun: true, json: true });
    const dryRun = readOutput(0);
    const dryAction = actionFor(dryRun, seeded.artificer);
    expect(dryAction.decision).toBe('would_reopen_successor');
    expect(dryAction.successorTaskId).toBe(seeded.deterministicId);
    expect(dryRun.createdCount).toBe(1);

    const afterDryRun = await snapshotTasks();
    expect(afterDryRun.count).toBe(before.count);
    expect(afterDryRun.rows).toEqual(before.rows);

    consoleLogSpy.mockClear();
    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, confirm: true, json: true });
    const confirm = readOutput(0);
    const confirmAction = actionFor(confirm, seeded.artificer);
    expect(confirmAction.decision).toBe('successor_created');
    expect(confirmAction.successorTaskId).toBe(seeded.deterministicId);
    expect(confirm.createdCount).toBe(1);

    const after = await snapshotTasks();
    expect(after.count).toBe(before.count);
    const reader = new RuntimeStateManager({ workspaceDir, readonly: true });
    await reader.initialize();
    try {
      const reopened = await reader.getTask(seeded.deterministicId);
      expect(reopened?.status).toBe('pending');
      expect(reopened?.attemptCount).toBe(0);
      const diagnostic = JSON.parse(String(reopened?.diagnosticJson)) as Record<string, unknown>;
      const pi = diagnostic[PI_METADATA_KEY] as Record<string, unknown>;
      const expectedCause = 'cascade-' + seeded.artificer + '-rc1-' + seeded.deterministicId;
      expect(pi.revisionCount).toBe(1);
      expect(pi.revisionCauseId).toBe(expectedCause);
      expect(pi.consumedRevisionCauseIds).toEqual([expectedCause]);
      expect(pi.runnerDecision).toBeUndefined();
    } finally {
      await reader.close();
    }
  });

  it('positive control: one real successor is reported as existing by both paths and is not reopened or duplicated', async () => {
    const seeded = await seedDatabase({ deterministicStatus: 'pending', timestampStatus: 'pending', includeTimestamp: false });
    const before = await snapshotTasks();

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, dryRun: true, json: true });
    const dryRun = readOutput(0);
    const dryAction = actionFor(dryRun, seeded.artificer);
    expect(dryAction.decision).toBe('successor_exists');
    expect(dryAction.successorTaskId).toBe(seeded.deterministicId);

    const afterDryRun = await snapshotTasks();
    expect(afterDryRun.count).toBe(before.count);
    expect(afterDryRun.rows).toEqual(before.rows);

    consoleLogSpy.mockClear();
    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, confirm: true, json: true });
    const confirm = readOutput(0);
    const confirmAction = actionFor(confirm, seeded.artificer);
    expect(confirmAction.decision).toBe('successor_exists');
    expect(confirmAction.successorTaskId).toBe(seeded.deterministicId);

    const after = await snapshotTasks();
    expect(after.count).toBe(before.count);
    expect(after.rows).toEqual(before.rows);
  });
});
