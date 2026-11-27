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
} & Record<string, unknown>): string {
  const {
    parentTaskId,
    correlationId,
    dependencyTaskIds,
    runnerDecision,
    revisionCount,
    ...extra
  } = meta;
  return JSON.stringify({
    [PI_METADATA_KEY]: {
      dependencyTaskIds: dependencyTaskIds ?? [],
      channel: 'prompt',
      pipelineMode: 'full_chain',
      timeoutMs: 300000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      ...(parentTaskId !== undefined ? { parentTaskId } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(runnerDecision !== undefined ? { runnerDecision } : {}),
      ...(revisionCount !== undefined ? { revisionCount } : {}),
      ...extra,
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

  it('needs_revision evaluator blocks before lineage in both dry-run and confirm', async () => {
    const writer = new RuntimeStateManager({ workspaceDir });
    await writer.initialize();
    try {
      await createTask(writer, 'evaluator-unprovable-needs-revision', 'evaluator', 'succeeded', {
        runnerDecision: 'needs_revision',
      });
    } finally {
      await writer.close();
    }
    const before = await snapshotTasks();

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, dryRun: true, json: true });
    const dryAction = actionFor(readOutput(0), 'evaluator-unprovable-needs-revision');
    expect(dryAction.decision).toBe('skipped');
    expect(String(dryAction.reason)).toContain('blocked_by_revision');
    expect(String(dryAction.reason)).not.toContain('lineage_refused');
    expect(await snapshotTasks()).toEqual(before);

    consoleLogSpy.mockClear();
    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, confirm: true, json: true });
    const confirmAction = actionFor(readOutput(0), 'evaluator-unprovable-needs-revision');
    expect(confirmAction.decision).toBe(dryAction.decision);
    expect(confirmAction.reason).toBe(dryAction.reason);
    expect(await snapshotTasks()).toEqual(before);
  });

  it('completed repair artificer previews and performs the same source evaluator reopen', async () => {
    const writer = new RuntimeStateManager({ workspaceDir });
    await writer.initialize();
    let evaluatorId = '';
    let repairId = '';
    try {
      const chain = await seedFullChain(writer);
      evaluatorId = 'evaluator-repair-source';
      repairId = 'artificer-repair-' + evaluatorId + '-r1';
      await createTask(writer, evaluatorId, 'evaluator', 'succeeded', {
        parentTaskId: chain.artificer,
        correlationId: CANDIDATE_ID,
        dependencyTaskIds: [chain.artificer],
        runnerDecision: 'needs_revision',
      });
      await createTask(writer, repairId, 'artificer', 'succeeded', {
        parentTaskId: evaluatorId,
        correlationId: CANDIDATE_ID,
        dependencyTaskIds: [chain.scribe],
        repairPayload: {
          requiredChanges: ['fix matcher'],
          concerns: ['adversarial case failed'],
          previousScore: 0.4,
          repairIteration: 1,
          sourceArtificerArtifactId: 'pi-art-source-artificer',
          sourceEvaluatorTaskId: evaluatorId,
          sourceEvaluatorRunId: 'run-' + evaluatorId,
        },
      });
    } finally {
      await writer.close();
    }
    const before = await snapshotTasks();

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, dryRun: true, json: true });
    const dryAction = actionFor(readOutput(0), repairId);
    expect(dryAction.decision).toBe('would_reopen_successor');
    expect(dryAction.successorTaskId).toBe(evaluatorId);
    expect(String(dryAction.reason)).toContain('revision_reopened');
    expect(await snapshotTasks()).toEqual(before);

    consoleLogSpy.mockClear();
    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, confirm: true, json: true });
    const confirmAction = actionFor(readOutput(0), repairId);
    expect(confirmAction.decision).toBe('successor_created');
    expect(confirmAction.successorTaskId).toBe(evaluatorId);

    const reader = new RuntimeStateManager({ workspaceDir, readonly: true });
    await reader.initialize();
    try {
      const reopened = await reader.getTask(evaluatorId);
      expect(reopened?.status).toBe('pending');
      expect(reopened?.attemptCount).toBe(0);
    } finally {
      await reader.close();
    }
  });

  async function seedSourceCorrectionChain(options: { outcomeRecorded: boolean }): Promise<{ scribe: string; artificer: string; causeId: string }> {
    const writer = new RuntimeStateManager({ workspaceDir });
    await writer.initialize();
    try {
      const dreamer = 'sc-dreamer';
      const philosopher = 'sc-philosopher';
      const scribe = 'sc-scribe';
      const artificer = 'sc-artificer';
      const causeId = 'rule-source-correction:' + CANDIDATE_ID + ':1';
      await createTask(writer, dreamer, 'dreamer', 'succeeded', { correlationId: CANDIDATE_ID }, CANDIDATE_ID);
      await createTask(writer, philosopher, 'philosopher', 'succeeded', { parentTaskId: dreamer, correlationId: CANDIDATE_ID });
      await createTask(writer, scribe, 'scribe', 'succeeded', {
        parentTaskId: philosopher,
        correlationId: CANDIDATE_ID,
        revisionCount: 1,
        revisionCauseId: causeId,
        sourceCorrectionCauseId: causeId,
        sourceCorrectionReceipt: {
          version: 1,
          candidateId: CANDIDATE_ID,
          scribeTaskId: scribe,
          artificerTaskId: artificer,
          sourceArtifactId: 'pi-art-scribe-source',
          sourceArtifactDigest: 'sha256:' + 'a'.repeat(64),
          bindingRevision: 1,
          decisionId: 'decision-1',
          expectedStopReasonCode: 'source_material_authorization_denied',
          reason: 'owner corrected source material',
          actor: 'owner',
          requestId: 'request-1',
          consumedAt: '2026-01-01T00:00:00.000Z',
          status: 'consumed',
          ...(options.outcomeRecorded ? { reopenOutcome: { kind: 'reopened', recordedAt: '2026-01-01T00:00:01.000Z' } } : {}),
        },
      });
      await createTask(writer, artificer, 'artificer', 'needs_human_review', {
        parentTaskId: scribe,
        correlationId: CANDIDATE_ID,
        dependencyTaskIds: [scribe],
        humanReviewContext: {
          reasonCode: 'source_material_authorization_denied',
          sourceRunId: 'run-sc-artificer',
          revisionEpoch: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      });
      return { scribe, artificer, causeId };
    } finally {
      await writer.close();
    }
  }

  it('source-correction scribe previews and performs the same targeted artificer reopen', async () => {
    const seeded = await seedSourceCorrectionChain({ outcomeRecorded: false });
    const before = await snapshotTasks();

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, dryRun: true, json: true });
    const dryAction = actionFor(readOutput(0), seeded.scribe);
    expect(dryAction.decision).toBe('would_reopen_successor');
    expect(dryAction.successorTaskId).toBe(seeded.artificer);
    expect(String(dryAction.reason)).toContain('source_correction_reopened');
    expect(await snapshotTasks()).toEqual(before);

    consoleLogSpy.mockClear();
    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, confirm: true, json: true });
    const confirmAction = actionFor(readOutput(0), seeded.scribe);
    expect(confirmAction.decision).toBe('successor_created');
    expect(confirmAction.successorTaskId).toBe(seeded.artificer);

    const reader = new RuntimeStateManager({ workspaceDir, readonly: true });
    await reader.initialize();
    try {
      const reopened = await reader.getTask(seeded.artificer);
      expect(reopened?.status).toBe('pending');
      const scribe = await reader.getTask(seeded.scribe);
      expect(String(scribe?.diagnosticJson)).toContain('reopened');
    } finally {
      await reader.close();
    }
  });

  it('source-correction idempotent replay is the same no-op in dry-run and confirm with zero writes', async () => {
    const seeded = await seedSourceCorrectionChain({ outcomeRecorded: true });
    const before = await snapshotTasks();

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, dryRun: true, json: true });
    const dryAction = actionFor(readOutput(0), seeded.scribe);
    expect(dryAction.decision).toBe('skipped');
    expect(String(dryAction.reason)).toContain('source_correction_reopen_noop');
    expect(await snapshotTasks()).toEqual(before);

    consoleLogSpy.mockClear();
    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, confirm: true, json: true });
    const confirmAction = actionFor(readOutput(0), seeded.scribe);
    expect(confirmAction.decision).toBe(dryAction.decision);
    expect(confirmAction.reason).toBe(dryAction.reason);
    expect(await snapshotTasks()).toEqual(before);
  });

  it('normal artificer to evaluator creation keeps the same positive business decision in dry-run and confirm', async () => {
    const writer = new RuntimeStateManager({ workspaceDir });
    await writer.initialize();
    let artificer = '';
    try {
      artificer = (await seedFullChain(writer)).artificer;
    } finally {
      await writer.close();
    }
    const before = await snapshotTasks();

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, dryRun: true, json: true });
    const dryAction = actionFor(readOutput(0), artificer);
    expect(dryAction.decision).toBe('would_create_successor');
    expect(dryAction.successorKind).toBe('evaluator');
    expect(await snapshotTasks()).toEqual(before);

    consoleLogSpy.mockClear();
    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: workspaceDir, confirm: true, json: true });
    const confirmAction = actionFor(readOutput(0), artificer);
    expect(confirmAction.decision).toBe('successor_created');
    expect(confirmAction.successorKind).toBe('evaluator');

    const after = await snapshotTasks();
    expect(after.count).toBe(before.count + 1);
  });

});
