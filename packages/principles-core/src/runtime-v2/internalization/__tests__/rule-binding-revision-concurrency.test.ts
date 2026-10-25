import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPITaskDiagnosticJson, hydratePITaskRecord, mergePITaskMetadata } from '../pitask-metadata.js';
import { reviseRuleBindingOnce } from '../rule-binding-revision.js';
import { createRuntimeStateHandle, type RuntimeStateHandle } from '../../runtime-state-handle.js';
import { SqliteDiagnosticianCommitter } from '../../store/commit/diagnostician-committer.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { CandidatePrincipleIdentityResolution } from '../../adapter/principle-tree-ledger-adapter.js';

const NOW = '2026-10-25T00:00:00.000Z';
const BINDING_REVISION = 4;
const MAX_ATTEMPTS = 5;

const diagnosis: DiagnosticianOutputV1 = {
  valid: true,
  diagnosisId: 'binding-revision-diagnosis',
  summary: 'The operation accepted an unscoped path.',
  rootCause: 'Design: the write path does not enforce scope.',
  violatedPrinciples: [],
  evidence: [],
  confidence: 0.9,
  recommendations: [
    { kind: 'rule', description: 'Reject writes that escape the approved scope.' },
  ],
};

describe('reviseRuleBindingOnce uses one bounded SQLite task revision', () => {
  let workspaceDir: string;
  let handle: RuntimeStateHandle;
  let candidateId: string;
  let scribeTaskId: string;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'pd-rule-binding-revision-'));
    handle = await createRuntimeStateHandle({ workspaceDir });
    await handle.stateManager.createTask({
      taskId: 'diagnosis', taskKind: 'diagnostician', status: 'succeeded',
      inputRef: 'original-evidence', attemptCount: 1, maxAttempts: 3,
    });
    await handle.stateManager.runStore.createRun({
      runId: 'diagnosis-run', taskId: 'diagnosis', runtimeKind: 'test-double',
      startedAt: NOW, attemptNumber: 1, executionStatus: 'succeeded',
      outputPayload: JSON.stringify(diagnosis),
    });
    await new SqliteDiagnosticianCommitter(handle.stateManager.connection).commit({
      taskId: 'diagnosis', runId: 'diagnosis-run', output: diagnosis,
      idempotencyKey: 'diagnosis-commit',
    });
    const ruleCandidate = (await handle.stateManager.getCandidatesByTaskId('diagnosis'))
      .find((candidate) => candidate.rawRecommendationKind === 'rule');
    if (!ruleCandidate) throw new Error('SqliteDiagnosticianCommitter did not create a rule candidate.');
    ({ candidateId } = ruleCandidate);

    const tasks: [string, 'dreamer' | 'philosopher' | 'scribe', string[]][] = [
      ['dreamer-task', 'dreamer', []],
      ['philosopher-task', 'philosopher', ['dreamer-task']],
      ['scribe-task', 'scribe', ['philosopher-task']],
    ];
    for (const [taskId, taskKind, dependencyTaskIds] of tasks) {
      const base = createPITaskDiagnosticJson({
        dependencyTaskIds, channel: 'code_tool_hook', timeoutMs: 1_000,
        inputArtifactRefs: [], outputArtifactRefs: [], pipelineMode: 'standard',
      });
      const diagnosticJson = taskKind === 'dreamer'
        ? JSON.stringify({ ...JSON.parse(base), candidateId })
        : base;
      await handle.stateManager.createTask({
        taskId, taskKind, status: 'succeeded', attemptCount: 2,
        maxAttempts: MAX_ATTEMPTS, diagnosticJson,
      });
    }
    scribeTaskId = 'scribe-task';
  });

  afterEach(async () => {
    await handle.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function ledger(): { resolveForCandidate: (id: string) => Promise<CandidatePrincipleIdentityResolution> } {
    return {
      resolveForCandidate: async (id) => ({
        status: 'resolved', candidateId: id, principleId: '11111111-2222-4222-8222-222222222222',
        basis: 'owner_rule_binding', bindingRevision: BINDING_REVISION,
        decisionId: '33333333-4444-4333-8333-444444444444', checkedAt: NOW,
      }),
    };
  }

  function revise(
    stateManager = handle.stateManager,
    overrides: Partial<Parameters<typeof reviseRuleBindingOnce>[0]> = {},
  ) {
    return reviseRuleBindingOnce({
      stateManager, ledger: ledger(), candidateId,
      expectedBindingRevision: BINDING_REVISION,
      expectedScribeTaskId: scribeTaskId,
      ...overrides,
    });
  }

  it('serializes two independent SQLite connections for the same binding cause and preserves the attempt ceiling', async () => {
    const secondHandle = await createRuntimeStateHandle({ workspaceDir });
    try {
      const results = await Promise.all([
        revise(handle.stateManager),
        revise(secondHandle.stateManager),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(['revision_already_started', 'revision_started']);
      const task = await handle.stateManager.getTask(scribeTaskId);
      expect(task).toMatchObject({ status: 'pending', attemptCount: 0, maxAttempts: MAX_ATTEMPTS });
      expect(task?.maxAttempts).toBe(MAX_ATTEMPTS);
      const metadata = task ? (await import('../pitask-metadata.js')).hydratePITaskRecord(task) : null;
      expect(metadata?.revisionCount).toBe(1);
      expect(metadata?.revisionCauseId).toBe(`rule-binding:${candidateId}:${BINDING_REVISION}`);
    } finally {
      await secondHandle.close();
    }
  });

  it('recognizes the same cause after the SQLite runtime is reopened', async () => {
    const first = await revise();
    expect(first.status).toBe('revision_started');
    await handle.close();
    handle = await createRuntimeStateHandle({ workspaceDir });

    expect(await revise()).toMatchObject({
      status: 'revision_already_started', scribeTaskId, taskRevisionEpoch: 1,
    });
    const task = await handle.stateManager.getTask(scribeTaskId);
    expect(task).toMatchObject({ status: 'pending', attemptCount: 0, maxAttempts: MAX_ATTEMPTS });
  });

  it('refuses a leased Scribe without changing any task state', async () => {
    // Far-future expiry: the refusal must depend on the lease being LIVE, not
    // on wall-clock luck (an expiry in the past reads as a crashed worker).
    await handle.stateManager.updateTask(scribeTaskId, {
      leaseOwner: 'active-worker', leaseExpiresAt: '2999-01-01T00:00:00.000Z',
    });
    const before = await handle.stateManager.getTask(scribeTaskId);

    expect(await revise()).toMatchObject({ status: 'refused', reason: 'task_lease_present' });
    expect(await handle.stateManager.getTask(scribeTaskId)).toEqual(before);
  });

  it('starts the revision past a crashed worker\'s expired lease and clears it', async () => {
    await handle.stateManager.updateTask(scribeTaskId, {
      leaseOwner: 'crashed-worker', leaseExpiresAt: '2000-01-01T00:00:00.000Z',
    });

    expect(await revise()).toMatchObject({ status: 'revision_started', scribeTaskId, taskRevisionEpoch: 1 });
    const task = await handle.stateManager.getTask(scribeTaskId);
    expect(task).toMatchObject({ status: 'pending', attemptCount: 0 });
    // Cleared lease columns read back as undefined/null depending on the row mapper.
    expect(task?.leaseOwner ?? null).toBeNull();
    expect(task?.leaseExpiresAt ?? null).toBeNull();
  });

  it('refuses a Scribe whose one-revision budget is already consumed without resetting attempts', async () => {
    const current = await handle.stateManager.getTask(scribeTaskId);
    if (!current?.diagnosticJson) throw new Error('Expected persisted Scribe PI metadata.');
    const pi = hydratePITaskRecord(current);
    if (!pi) throw new Error('Expected valid PI metadata.');
    await handle.stateManager.updateTask(scribeTaskId, {
      diagnosticJson: createPITaskDiagnosticJson(mergePITaskMetadata(pi, { revisionCount: 1, ruleBindingRevisionCauseId: `rule-binding:${candidateId}:1` })),
      attemptCount: 3,
    });
    const before = await handle.stateManager.getTask(scribeTaskId);

    expect(await revise()).toMatchObject({ status: 'refused', reason: 'revision_budget_exhausted' });
    expect(await handle.stateManager.getTask(scribeTaskId)).toEqual(before);
  });

  it('does not mistake an ordinary historical revision for a spent binding-repair budget', async () => {
    const task = await handle.stateManager.getTask(scribeTaskId);
    const pi = task ? hydratePITaskRecord(task) : null;
    if (!pi) throw new Error('Expected PI task.');
    await handle.stateManager.updateTask(scribeTaskId, { diagnosticJson: createPITaskDiagnosticJson(mergePITaskMetadata(pi, { revisionCount: 1, revisionCauseId: 'ordinary-owner-revision' })) });
    expect(await revise()).toMatchObject({ status: 'revision_started', taskRevisionEpoch: 2 });
    const fresh = await handle.stateManager.getTask(scribeTaskId);
    expect(fresh).toMatchObject({ status: 'pending', attemptCount: 0, maxAttempts: MAX_ATTEMPTS });
    expect(fresh && hydratePITaskRecord(fresh)?.ruleBindingRevisionCauseId).toBe(`rule-binding:${candidateId}:${BINDING_REVISION}`);
    expect(await revise()).toMatchObject({ status: 'revision_already_started', taskRevisionEpoch: 2 });
  });

  it('refuses a caller-nominated unrelated Scribe and leaves the verified chain untouched', async () => {
    await handle.stateManager.createTask({
      taskId: 'unrelated-scribe', taskKind: 'scribe', status: 'succeeded',
      attemptCount: 1, maxAttempts: MAX_ATTEMPTS,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [], channel: 'code_tool_hook', timeoutMs: 1_000,
        inputArtifactRefs: [], outputArtifactRefs: [],
      }),
    });
    const before = await handle.stateManager.getTask(scribeTaskId);

    expect(await revise(handle.stateManager, { expectedScribeTaskId: 'unrelated-scribe' }))
      .toMatchObject({ status: 'refused', reason: 'scribe_target_mismatch' });
    expect(await handle.stateManager.getTask(scribeTaskId)).toEqual(before);
    expect(await handle.stateManager.getTask('unrelated-scribe')).toMatchObject({ status: 'succeeded', attemptCount: 1 });
  });
});
