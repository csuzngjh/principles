import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRuntimeStateHandle,
  SqliteDiagnosticianCommitter,
  type RuntimeStateHandle,
  type DiagnosticianOutputV1,
} from '@principles/core/runtime-v2';
import { RuleCandidateBindingConsoleModel } from '../../src/server/models/RuleCandidateBindingConsoleModel.js';

const NOW = '2026-10-26T00:00:00.000Z';

/**
 * PRI-1048 U01: the binding queue must aggregate by canonical candidateId.
 * getCandidatesByTaskId(taskId) spans "own + child tasks" by design
 * (t.task_id = ? OR t.input_ref = ?), so a candidate committed on a
 * diag_router sub-task is already surfaced through the parent diagnostician;
 * iterating both task lists and pushing naively shows it twice. The queue
 * aggregation owner dedupes by candidateId; the shared store query keeps
 * its existing semantics for every other consumer.
 */
const splitDiagnosis: DiagnosticianOutputV1 = {
  valid: true,
  diagnosisId: 'queue-dedup-split-diagnosis',
  summary: 'The change shipped without a confirmed design.',
  rootCause: 'Design: direction approval was treated as design confirmation.',
  violatedPrinciples: [],
  evidence: [],
  confidence: 0.9,
  recommendations: [
    { kind: 'rule', description: 'Require a confirmed design before non-trivial behavior changes.' },
  ],
};

/** Same pain, same rule text, TWO distinct candidates — must both stay visible. */
const twinTextDiagnosis: DiagnosticianOutputV1 = {
  valid: true,
  diagnosisId: 'queue-dedup-twin-diagnosis',
  summary: 'The reply buried the conclusion.',
  rootCause: 'Delivery: conclusion was not front-loaded.',
  violatedPrinciples: [],
  evidence: [],
  confidence: 0.8,
  recommendations: [
    { kind: 'rule', description: 'Front-load the conclusion in every owner-facing reply.' },
    { kind: 'rule', description: 'Front-load the conclusion in every owner-facing reply.' },
  ],
};

type Fixture = {
  workspaceDir: string;
  handle: RuntimeStateHandle;
  routerRuleCandidateId: string;
  parentRuleCandidateId: string;
  twinCandidateIds: string[];
  hashWorkspaceState: () => string;
};

async function commitDiagnosis(
  handle: RuntimeStateHandle,
  args: { taskId: string; inputRef: string; runId: string; output: DiagnosticianOutputV1; key: string },
): Promise<void> {
  await handle.stateManager.createTask({
    taskId: args.taskId, taskKind: args.taskId.startsWith('diag_router') ? 'diag_router' : 'diagnostician',
    status: 'succeeded', inputRef: args.inputRef, attemptCount: 1, maxAttempts: 3,
  });
  await handle.stateManager.runStore.createRun({
    runId: args.runId, taskId: args.taskId, runtimeKind: 'test-double',
    startedAt: NOW, attemptNumber: 1, executionStatus: 'succeeded',
    outputPayload: JSON.stringify(args.output),
  });
  await new SqliteDiagnosticianCommitter(handle.stateManager.connection).commit({
    taskId: args.taskId, runId: args.runId, output: args.output, idempotencyKey: args.key,
  });
}

async function createFixture(): Promise<Fixture> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'pd-binding-queue-dedup-'));
  const handle = await createRuntimeStateHandle({ workspaceDir });

  // Split provenance: the router sub-task commits its own run/artifact and is
  // parented (inputRef) by the succeeded diagnostician — the production shape.
  await commitDiagnosis(handle, {
    taskId: 'diagnosis-parent', inputRef: 'pain-split', runId: 'run-parent',
    output: splitDiagnosis, key: 'queue-dedup-parent-commit',
  });
  await commitDiagnosis(handle, {
    taskId: 'diag_router-diagnosis-parent', inputRef: 'diagnosis-parent', runId: 'run-router',
    output: splitDiagnosis, key: 'queue-dedup-router-commit',
  });
  const splitCandidates = await handle.stateManager.getCandidatesByTaskId('diagnosis-parent');
  const parentRule = splitCandidates.find(c => c.taskId === 'diagnosis-parent' && c.rawRecommendationKind === 'rule');
  const routerRule = splitCandidates.find(c => c.taskId === 'diag_router-diagnosis-parent' && c.rawRecommendationKind === 'rule');
  if (!parentRule || !routerRule) throw new Error('Real committer did not produce both split-provenance rule candidates.');

  // One pain, two distinct rule candidates with identical text (direct provenance).
  await commitDiagnosis(handle, {
    taskId: 'diagnosis-twins', inputRef: 'pain-twins', runId: 'run-twins',
    output: twinTextDiagnosis, key: 'queue-dedup-twin-commit',
  });
  const twinCandidates = (await handle.stateManager.getCandidatesByTaskId('diagnosis-twins'))
    .filter(c => c.rawRecommendationKind === 'rule');
  if (twinCandidates.length !== 2) throw new Error('Twin fixture did not produce exactly two rule candidates.');

  const hashWorkspaceState = (): string => {
    const stateDb = readFileSync(join(workspaceDir, '.pd', 'state.db'));
    return createHash('sha256').update(stateDb).digest('hex');
  };
  return { workspaceDir, handle, routerRuleCandidateId: routerRule.candidateId, parentRuleCandidateId: parentRule.candidateId, twinCandidateIds: twinCandidates.map(c => c.candidateId), hashWorkspaceState };
}

describe('rule binding queue aggregation (PRI-1048)', () => {
  let fixture: Fixture;

  beforeEach(async () => { fixture = await createFixture(); });
  afterEach(async () => {
    await fixture.handle.close();
    rmSync(fixture.workspaceDir, { recursive: true, force: true });
  });

  it('lists a split-provenance candidate exactly once (was: parent + router both push it)', async () => {
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const occurrences = queue.items.filter(item => item.candidateId === fixture.routerRuleCandidateId);
    expect(occurrences, 'router-committed candidate must appear exactly once across parent+router traversal').toHaveLength(1);
    const ids = queue.items.map(item => item.candidateId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(fixture.parentRuleCandidateId);
  });

  it('keeps distinct candidates with identical text on the same pain (no text-based dedup)', async () => {
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const [first, second] = fixture.twinCandidateIds;
    expect(queue.items.filter(item => item.candidateId === first)).toHaveLength(1);
    expect(queue.items.filter(item => item.candidateId === second)).toHaveLength(1);
  });

  it('repeated list() reads do not accumulate entries', async () => {
    const model = new RuleCandidateBindingConsoleModel(fixture.workspaceDir);
    const first = await model.list();
    const second = await model.list();
    expect(second.items.map(item => item.candidateId).sort())
      .toEqual(first.items.map(item => item.candidateId).sort());
  });

  it('drives the queue cap to its boundary: 201 candidates → 200 items, truncated, true count kept (ERR-134)', async () => {
    // One diagnosis whose output carries 201 distinct rule recommendations —
    // the real committer creates one candidate per recommendation.
    const flood: DiagnosticianOutputV1 = {
      valid: true,
      diagnosisId: 'queue-dedup-flood-diagnosis',
      summary: 'Flood.',
      rootCause: 'Flood.',
      violatedPrinciples: [],
      evidence: [],
      confidence: 0.5,
      recommendations: Array.from({ length: 201 }, (_, index) => ({
        kind: 'rule' as const,
        description: `Flood rule candidate #${index + 1}.`,
      })),
    };
    await commitDiagnosis(fixture.handle, {
      taskId: 'diagnosis-flood', inputRef: 'pain-flood', runId: 'run-flood',
      output: flood, key: 'queue-dedup-flood-commit',
    });
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    expect(queue.items).toHaveLength(200);
    expect(queue.truncated).toBe(true);
    // Single basis: every summary count covers the DISPLAYED items only.
    expect(queue.summary.candidates).toBe(200);
  });

  it('list() and review() perform zero governance writes', async () => {
    const before = fixture.hashWorkspaceState();
    const model = new RuleCandidateBindingConsoleModel(fixture.workspaceDir);
    await model.list();
    await model.review(fixture.routerRuleCandidateId, '');
    expect(fixture.hashWorkspaceState(), 'state.db bytes must be unchanged by queue/review reads').toBe(before);
  });
});
