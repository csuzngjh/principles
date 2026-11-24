/**
 * SPEC-PD-PIPELINE-SPINE-001 D4 (review round 2, P1-2) — state consistency of
 * a candidate refused at the AUTOMATIC seed gate (PainSignalBridge).
 *
 * Defect (round 1): an invalid / missing RAW kind skipped the seed AND the
 * consumed update, but the completion loop still wrote
 * `processing.state = 'complete'` — a PENDING candidate with a COMPLETE
 * processing record. The worker then never rescanned it and nothing durable
 * said why.
 *
 * Contract: the refusal is a SAVED state in the existing state machine —
 * candidate stays `pending`, processing is `awaiting_owner` with
 * `blockedReason: candidate_kind_invalid:<raw>` and a real recovery
 * `nextAction`; zero Dreamer tasks; the outcome reports the structured
 * refusal; re-runs are idempotent; a repaired candidate resumes; a failing
 * telemetry sink cannot break the state write or the rest of the batch.
 *
 * Real SQLite workspace (RuntimeStateManager, diagnostician committer,
 * CandidateIntakeService, PrincipleTreeLedgerAdapter); only the runner (the
 * LLM boundary) is a stub. Every assertion reads the DATABASE.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiagnosticianOutputV2 } from '../diagnostician-output.js';

import { PainSignalBridge } from '../pain-signal-bridge.js';
import { RuntimeStateManager, type CandidateRecord } from '../store/runtime-state-manager.js';
import { SqliteDiagnosticianCommitter } from '../store/commit/diagnostician-committer.js';
import { CandidateIntakeService } from '../candidate-intake-service.js';
import { PrincipleTreeLedgerAdapter } from '../adapter/principle-tree-ledger-adapter.js';
import { buildOwnerDecisionIntent } from '../store/candidate/admission-document.js';

const worlds: World[] = [];

afterEach(async () => {
  // release every SQLite handle BEFORE the temp tree is removed (Windows
  // keeps the files locked through open handles)
  for (const world of worlds.splice(0)) {
    await world.bridge.dispose().catch(() => undefined);
    rmSync(world.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

type RecommendationKind = 'principle' | 'rule' | 'defer';

interface World {
  root: string;
  workspaceDir: string;
  stateManager: RuntimeStateManager;
  bridge: PainSignalBridge;
  telemetry: Record<string, unknown>[];
  options: { failTelemetry: boolean };
}

function createBridgeForWorld(world: Pick<World, 'workspaceDir' | 'telemetry' | 'options'>, stateManager: RuntimeStateManager): PainSignalBridge {
  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: join(world.workspaceDir, '.state') });
  return new PainSignalBridge({
    stateManager,
    // the LLM boundary only — never reached by onDiagnosisComplete
    runner: {
      run: async (taskId: string) => ({ status: 'succeeded', taskId, attemptCount: 1 }),
    },
    intakeService: new CandidateIntakeService({ stateManager, ledgerAdapter }),
    ledgerAdapter,
    autoIntakeEnabled: true,
    workspaceDir: world.workspaceDir,
    isAutoPainSubmissionAuthorized: () => true,
    eventEmitter: {
      emitTelemetry: (event: Record<string, unknown>) => {
        if (world.options.failTelemetry) throw new Error('telemetry sink down');
        world.telemetry.push(event);
      },
    },
  });
}

async function restartWorker(world: World): Promise<void> {
  await world.bridge.dispose();
  await world.stateManager.close();
  const stateManager = new RuntimeStateManager({ workspaceDir: world.workspaceDir });
  await stateManager.initialize();
  world.stateManager = stateManager;
  world.bridge = createBridgeForWorld(world, stateManager);
}

async function createWorld(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'pri-1291-seed-refusal-'));
  const workspaceDir = join(root, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  const telemetry: Record<string, unknown>[] = [];
  const options = { failTelemetry: false };
  const world: World = {
    root,
    workspaceDir,
    stateManager,
    bridge: undefined as unknown as PainSignalBridge,
    telemetry,
    options,
  };
  world.bridge = createBridgeForWorld(world, stateManager);
  worlds.push(world);
  return world;
}

function diagnosticJson(painId: string): string {
  return JSON.stringify({
    sourcePainId: painId,
    reasonSummary: 'Deviated from the owner-review contract',
    source: 'test',
    severity: 'high',
    sessionIdHint: null,
    agentIdHint: null,
    provenance: 'automatic_hook',
    provenanceReason: 'automatic hook',
    evidence: [{ sourceRef: 'session://test', note: 'deviated' }],
    workspaceDir: null,
  });
}

function outputFor(painId: string, kinds: readonly RecommendationKind[]): DiagnosticianOutputV2 {
  return {
    valid: true,
    diagnosisId: `diag-${painId}`,
    summary: 'Deviation observed',
    rootCause: 'Agent skipped the owner review',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session://test', note: 'deviated' }],
    recommendations: kinds.map((kind, index) => ({
      kind,
      description: `Recommendation ${index} for ${painId}`,
      recommendationRef: `rec-${painId}-${index}`,
      ...(kind === 'principle' ? { abstractedPrinciple: 'Never skip the owner review gate for destructive actions' } : {}),
      ...(kind === 'rule'
        ? {
            triggerPattern: 'rm\\s+-rf',
            action: 'require explicit owner confirmation',
            principleAssociation: { status: 'unresolved', reason: 'no_supported_target' },
          }
        : {}),
    })),
    confidence: 0.9,
    schemaVersion: 'diagnostician-output-v2',
  } as DiagnosticianOutputV2;
}

/** A real diagnosis commit: task → run → artifacts → principle_candidates rows. */
async function commitDiagnosis(world: World, painId: string, kinds: readonly RecommendationKind[]): Promise<{ taskId: string; output: DiagnosticianOutputV2; candidates: CandidateRecord[] }> {
  const { stateManager } = world;
  const taskId = `diagnostician-${painId}`;
  const output = outputFor(painId, kinds);
  await stateManager.createTask({
    taskId,
    taskKind: 'diagnostician',
    inputRef: painId,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: diagnosticJson(painId),
  });
  const committer = new SqliteDiagnosticianCommitter(stateManager.connection);
  const lease = await stateManager.acquireLeaseDetailed({ taskId, owner: 'seed-refusal-test', durationMs: 60_000, runtimeKind: 'openclaw' });
  const fence = { taskId, owner: 'seed-refusal-test', leaseGeneration: lease.leaseGeneration };
  const committed = await committer.commit({ runId: lease.runId, taskId, output, idempotencyKey: `idem-${taskId}` });
  await stateManager.markTaskSucceeded(taskId, `artifact://${committed.artifactId}`, fence, lease.runId);
  await stateManager.updateRunOutput(lease.runId, JSON.stringify(output));
  return { taskId, output, candidates: await stateManager.getCandidatesByTaskId(taskId) };
}

/** Corrupt the PERSISTED kind of one candidate row (bound parameters). */
function setPersistedKind(world: World, candidateId: string, raw: string): void {
  world.stateManager.connection.getDb().prepare('UPDATE principle_candidates SET recommendation_kind = ? WHERE candidate_id = ?').run(raw, candidateId);
}

async function runPostProcessing(
  world: World,
  diagnosis: { taskId: string; output: DiagnosticianOutputV2 },
  painId: string,
): Promise<ReturnType<PainSignalBridge['onDiagnosisComplete']>> {
  const { taskId, output } = diagnosis;
  return world.bridge.onDiagnosisComplete({ taskId, diagnosticianOutput: output, painId, provenance: 'host_context_bound', inputEvidenceCount: 2 });
}

async function candidateOf(world: World, candidateId: string): Promise<CandidateRecord> {
  const candidate = await world.stateManager.getCandidate(candidateId);
  if (candidate === null) throw new Error(`candidate ${candidateId} not found`);
  return candidate;
}

async function processingOf(world: World, candidateId: string): Promise<Record<string, unknown> | undefined> {
  const document = await world.stateManager.getAdmissionDocument(candidateId);
  const processing: unknown = document.ok ? document.document?.processing : undefined;
  return typeof processing === 'object' && processing !== null ? (processing as Record<string, unknown>) : undefined;
}

async function dreamerTasksFor(world: World, candidateId: string): Promise<string[]> {
  const tasks = await world.stateManager.listTasks();
  return tasks.filter((task) => task.taskKind === 'dreamer' && task.taskId.includes(candidateId)).map((task) => task.taskId);
}

function outcomeOf(result: Awaited<ReturnType<PainSignalBridge['onDiagnosisComplete']>>, candidateId: string): { reason: string; nextAction: string } {
  const outcome = result.candidateOutcomes?.find((item) => item.candidateId === candidateId);
  if (outcome === undefined) throw new Error(`no outcome for ${candidateId}`);
  return outcome;
}

async function byKind(candidates: readonly CandidateRecord[], kind: string): Promise<CandidateRecord> {
  const found = candidates.find((candidate) => candidate.rawRecommendationKind === kind);
  if (found === undefined) throw new Error(`no ${kind} candidate`);
  return found;
}

/** The saved refusal state, read back from the database. */
async function expectSavedRefusal(world: World, candidateId: string, blockedReason: string): Promise<void> {
  expect((await candidateOf(world, candidateId)).status).toBe('pending');
  const processing = await processingOf(world, candidateId);
  expect(processing?.state).toBe('awaiting_owner');
  expect(processing?.blockedReason).toBe(blockedReason);
  const lastFailure = processing?.lastFailure as { reason?: string; nextAction?: string } | undefined;
  expect(lastFailure?.reason).toBe('candidate_kind_invalid');
  expect(lastFailure?.nextAction).toContain('Repair the persisted RAW kind from the source recommendation');
  expect(lastFailure?.nextAction).toContain(`pd candidate resume-post-processing --candidate-id ${candidateId} --workspace "${world.workspaceDir}"`);
  expect(lastFailure?.nextAction).toContain('--confirm');
  expect(await dreamerTasksFor(world, candidateId)).toEqual([]);
}

describe('P1-2 — automatic seed gate: a refused candidate is a SAVED state, never pending+complete', () => {
  it('invalid raw kind: zero seeding, saved awaiting_owner refusal, structured outcome + telemetry', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-invalid', ['principle']);
    const [invalid] = candidates;
    if (invalid === undefined) throw new Error('no candidate');
    setPersistedKind(world, invalid.candidateId, 'wizardry');

    const result = await runPostProcessing(world, { taskId, output }, 'pain-invalid');

    await expectSavedRefusal(world, invalid.candidateId, 'candidate_kind_invalid:wizardry');
    const outcome = outcomeOf(result, invalid.candidateId);
    expect(outcome.reason).toBe('candidate_kind_invalid');
    expect(outcome.nextAction).toContain('pd candidate resume-post-processing --candidate-id');
    expect(outcome.nextAction).not.toContain('pd candidate intake --candidate-id');
    const refused = world.telemetry.filter((event) => event.eventType === 'candidate_seed_refused');
    expect(refused).toHaveLength(1);
    expect((refused[0]?.payload as Record<string, unknown>).candidateId).toBe(invalid.candidateId);
  });

  it('missing raw kind (empty persisted value): same saved refusal, blocker says missing', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-missing', ['principle']);
    const [missing] = candidates;
    if (missing === undefined) throw new Error('no candidate');
    setPersistedKind(world, missing.candidateId, '');

    await runPostProcessing(world, { taskId, output }, 'pain-missing');

    await expectSavedRefusal(world, missing.candidateId, 'candidate_kind_invalid:missing');
  });

  it('legal principle candidate: negative control — ledger entry, Dreamer seed, consumed, complete', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-principle', ['principle']);
    const principle = await byKind(candidates, 'principle');

    const result = await runPostProcessing(world, { taskId, output }, 'pain-principle');

    expect((await candidateOf(world, principle.candidateId)).status).toBe('consumed');
    expect((await processingOf(world, principle.candidateId))?.state).toBe('complete');
    expect(await dreamerTasksFor(world, principle.candidateId)).toHaveLength(1);
    expect(outcomeOf(result, principle.candidateId).reason).not.toBe('candidate_kind_invalid');
    expect(world.telemetry.some((event) => event.eventType === 'candidate_seed_refused')).toBe(false);
  });

  it('legal rule candidate: negative control — Dreamer seed on the code_tool_hook channel, consumed, complete', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-rule', ['rule']);
    const rule = await byKind(candidates, 'rule');

    await runPostProcessing(world, { taskId, output }, 'pain-rule');

    expect((await candidateOf(world, rule.candidateId)).status).toBe('consumed');
    expect((await processingOf(world, rule.candidateId))?.state).toBe('complete');
    expect(await dreamerTasksFor(world, rule.candidateId)).toEqual([`dreamer-${rule.candidateId}-code_tool_hook`]);
  });

  it('mixed batch in ONE round: the refused candidate does not disturb its legal siblings', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-mixed', ['principle', 'rule', 'defer', 'principle']);
    const deferred = await byKind(candidates, 'defer');
    const [legalPrinciple, toRefuse] = candidates.filter((candidate) => candidate.rawRecommendationKind === 'principle');
    const rule = await byKind(candidates, 'rule');
    if (legalPrinciple === undefined || toRefuse === undefined) throw new Error('fixtures');
    setPersistedKind(world, toRefuse.candidateId, 'wizardry');

    const result = await runPostProcessing(world, { taskId, output }, 'pain-mixed');

    await expectSavedRefusal(world, toRefuse.candidateId, 'candidate_kind_invalid:wizardry');
    expect((await candidateOf(world, legalPrinciple.candidateId)).status).toBe('consumed');
    expect((await processingOf(world, legalPrinciple.candidateId))?.state).toBe('complete');
    expect(await dreamerTasksFor(world, legalPrinciple.candidateId)).toHaveLength(1);
    expect((await candidateOf(world, rule.candidateId)).status).toBe('consumed');
    expect(await dreamerTasksFor(world, rule.candidateId)).toHaveLength(1);
    // the defer sibling keeps its legal no-seed route
    expect(await dreamerTasksFor(world, deferred.candidateId)).toEqual([]);
    expect(outcomeOf(result, toRefuse.candidateId).reason).toBe('candidate_kind_invalid');
    expect(outcomeOf(result, legalPrinciple.candidateId).reason).not.toBe('candidate_kind_invalid');
  });

  it('re-running the same round is idempotent: still refused, no duplicate tasks, no state drift', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-retry', ['principle', 'principle']);
    const [toRefuse, legal] = candidates;
    if (toRefuse === undefined || legal === undefined) throw new Error('fixtures');
    setPersistedKind(world, toRefuse.candidateId, 'wizardry');
    await runPostProcessing(world, { taskId, output }, 'pain-retry');
    const before = await processingOf(world, toRefuse.candidateId);

    await runPostProcessing(world, { taskId, output }, 'pain-retry');
    await runPostProcessing(world, { taskId, output }, 'pain-retry');

    await expectSavedRefusal(world, toRefuse.candidateId, 'candidate_kind_invalid:wizardry');
    // three rounds later the saved state is byte-for-byte the same one
    const after = await processingOf(world, toRefuse.candidateId);
    expect(after?.state).toBe(before?.state);
    expect(after?.blockedReason).toBe(before?.blockedReason);
    expect(after?.attempts).toBe(0);
    expect(await dreamerTasksFor(world, legal.candidateId)).toHaveLength(1);
  });

  it('raw-kind repair alone cannot resume; explicit Owner authorization is audited, idempotent and survives worker restart', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-repair', ['principle']);
    const [candidate] = candidates;
    if (candidate === undefined) throw new Error('no candidate');
    setPersistedKind(world, candidate.candidateId, 'wizardry');
    await runPostProcessing(world, { taskId, output }, 'pain-repair');
    await expectSavedRefusal(world, candidate.candidateId, 'candidate_kind_invalid:wizardry');

    // A still-invalid raw kind cannot be authorized.
    const invalidAttempt = await world.stateManager.authorizeInvalidKindPostProcessingRecovery(candidate.candidateId, {
      ownerId: 'owner-recovery-test', identitySource: 'file', reason: 'Repair raw kind', authorizedAt: new Date().toISOString(),
    });
    expect(invalidAttempt).toMatchObject({ status: 'refused', reason: 'candidate_kind_still_invalid' });

    // The worker must not treat a manual raw-kind edit as authorization.
    setPersistedKind(world, candidate.candidateId, 'principle');
    const stillBlocked = await world.bridge.resumeSucceededDiagnosisPostProcessing({ taskId });
    expect(stillBlocked.status).toBe('not_applicable');
    expect(stillBlocked.skipped?.map((item) => item.reason)).toEqual(['processing_awaiting_owner']);
    expect(await dreamerTasksFor(world, candidate.candidateId)).toEqual([]);

    const authorization = {
      ownerId: 'owner-recovery-test',
      identitySource: 'file',
      reason: 'Restored the intended principle kind from the persisted source recommendation',
      authorizedAt: new Date().toISOString(),
    };
    const authorized = await world.stateManager.authorizeInvalidKindPostProcessingRecovery(candidate.candidateId, authorization);
    expect(authorized.status).toBe('authorized');
    if (authorized.status === 'refused') throw new Error(authorized.reason);
    expect(authorized.document.processing?.state).toBe('in_progress');
    expect(authorized.recovery).toMatchObject({
      candidateId: candidate.candidateId,
      rawRecommendationKind: 'principle',
      priorBlockedReason: 'candidate_kind_invalid:wizardry',
      ownerId: 'owner-recovery-test',
      identitySource: 'file',
      reason: authorization.reason,
    });
    const duplicateAuthorization = await world.stateManager.authorizeInvalidKindPostProcessingRecovery(candidate.candidateId, authorization);
    expect(duplicateAuthorization.status).toBe('already_authorized');
    if (duplicateAuthorization.status === 'refused') throw new Error(duplicateAuthorization.reason);
    expect(duplicateAuthorization.recovery.recoveryId).toBe(authorized.recovery.recoveryId);

    // A new state manager + bridge models a worker process restart. The
    // authorized in_progress row must be visible in the ordinary backlog.
    await restartWorker(world);
    const backlog = await world.stateManager.listDiagnosisPostProcessingBacklog({ limit: 100 });
    expect(backlog.eligible.some((item) => item.candidateId === candidate.candidateId && item.processingState === 'in_progress')).toBe(true);

    const resumed = await world.bridge.resumeSucceededDiagnosisPostProcessing({ taskId });
    expect(resumed.status).toBe('resumed');
    expect(resumed.processedCandidateIds).toEqual([candidate.candidateId]);
    expect((await candidateOf(world, candidate.candidateId)).status).toBe('consumed');
    expect((await processingOf(world, candidate.candidateId))?.state).toBe('complete');
    const recoveryAudit = await world.stateManager.getAdmissionDocument(candidate.candidateId);
    expect(recoveryAudit.ok).toBe(true);
    if (!recoveryAudit.ok) throw new Error(recoveryAudit.reason);
    expect(recoveryAudit.document?.postProcessingRecoveries).toHaveLength(1);
    expect(await dreamerTasksFor(world, candidate.candidateId)).toHaveLength(1);

    // Idempotency must also survive the worker consuming the candidate:
    // a retry returns the original audit record and does not rewrite state.
    const afterCompletionDuplicate = await world.stateManager.authorizeInvalidKindPostProcessingRecovery(candidate.candidateId, authorization);
    expect(afterCompletionDuplicate.status).toBe('already_authorized');
    if (afterCompletionDuplicate.status === 'refused') throw new Error(afterCompletionDuplicate.reason);
    expect(afterCompletionDuplicate.recovery.recoveryId).toBe(authorized.recovery.recoveryId);
    const changedAuthorization = await world.stateManager.authorizeInvalidKindPostProcessingRecovery(candidate.candidateId, {
      ...authorization,
      reason: 'A different authorization must not reopen a consumed candidate',
    });
    expect(changedAuthorization).toMatchObject({ status: 'refused', reason: 'candidate_not_pending' });

    const replay = await world.bridge.resumeSucceededDiagnosisPostProcessing({ taskId });
    expect(replay.status).toBe('not_applicable');
    expect(await dreamerTasksFor(world, candidate.candidateId)).toHaveLength(1);
  });

  it('a failing telemetry sink neither breaks the saved refusal state nor the rest of the batch', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-telemetry', ['principle', 'principle']);
    const [toRefuse, legal] = candidates;
    if (toRefuse === undefined || legal === undefined) throw new Error('fixtures');
    setPersistedKind(world, toRefuse.candidateId, 'wizardry');
    world.options.failTelemetry = true;

    const result = await runPostProcessing(world, { taskId, output }, 'pain-telemetry');

    await expectSavedRefusal(world, toRefuse.candidateId, 'candidate_kind_invalid:wizardry');
    expect((await candidateOf(world, legal.candidateId)).status).toBe('consumed');
    expect(await dreamerTasksFor(world, legal.candidateId)).toHaveLength(1);
    expect(outcomeOf(result, toRefuse.candidateId).reason).toBe('candidate_kind_invalid');
  });
  it('does not recover a genuine reuse_pending_owner park or a candidate with a pending Owner decision', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-owner-park', ['principle']);
    const [candidate] = candidates;
    if (candidate === undefined) throw new Error('no candidate');
    setPersistedKind(world, candidate.candidateId, 'wizardry');
    await runPostProcessing(world, { taskId, output }, 'pain-owner-park');
    setPersistedKind(world, candidate.candidateId, 'principle');

    const reusePark = await world.stateManager.updateAdmissionProcessing(candidate.candidateId, {
      state: 'awaiting_owner',
      attempts: 0,
      lastFailure: { reason: 'reuse_pending_owner', nextAction: 'Wait for Owner review', at: new Date().toISOString() },
      blockedReason: 'reuse_pending_owner',
    });
    expect(reusePark).toBe(true);
    const reuseDenied = await world.stateManager.authorizeInvalidKindPostProcessingRecovery(candidate.candidateId, {
      ownerId: 'owner-recovery-test', identitySource: 'file', reason: 'try not to resume reuse park', authorizedAt: new Date().toISOString(),
    });
    expect(reuseDenied).toMatchObject({ status: 'refused', reason: 'processing_not_blocked_by_invalid_raw_kind' });
    expect((await world.stateManager.getAdmissionDocument(candidate.candidateId)).ok).toBe(true);

    // Even an invalid-kind blocker is not recoverable while a typed Owner
    // decision intent is pending.
    await world.stateManager.updateAdmissionProcessing(candidate.candidateId, {
      state: 'awaiting_owner',
      attempts: 0,
      blockedReason: 'candidate_kind_invalid:wizardry',
      lastFailure: { reason: 'candidate_kind_invalid', nextAction: 'repair raw kind', at: new Date().toISOString() },
    });
    const intent = buildOwnerDecisionIntent({
      candidateId: candidate.candidateId,
      decision: 'create',
      ownerId: 'owner-recovery-test',
      identitySource: 'file',
      reason: 'Pending Owner decision must win over recovery',
    });
    const recorded = await world.stateManager.recordOwnerDecision(candidate.candidateId, intent);
    expect(recorded.status).toBe('appended');
    const pendingDenied = await world.stateManager.authorizeInvalidKindPostProcessingRecovery(candidate.candidateId, {
      ownerId: 'owner-recovery-test', identitySource: 'file', reason: 'must not bypass pending Owner decision', authorizedAt: new Date().toISOString(),
    });
    expect(pendingDenied).toMatchObject({ status: 'refused', reason: 'owner_decision_pending_recovery_forbidden' });
    const admission = await world.stateManager.getAdmissionDocument(candidate.candidateId);
    expect(admission.ok && admission.document?.postProcessingRecoveries).toBeUndefined();
    expect(await dreamerTasksFor(world, candidate.candidateId)).toEqual([]);
  });


  it('worker resume processes only authorized/in-progress candidates and never releases an awaiting_owner sibling in the same batch', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-mixed-recovery', ['principle', 'principle']);
    const [invalid, sibling] = candidates;
    if (!invalid || !sibling) throw new Error('expected two candidates');

    // Persist a real pending Owner decision for the sibling before the
    // diagnosis continuation runs; it must never receive an independent seed.
    const siblingIntent = buildOwnerDecisionIntent({
      candidateId: sibling.candidateId,
      decision: 'create',
      ownerId: 'owner-recovery-test',
      identitySource: 'file',
      reason: 'Keep this sibling parked while the first candidate is repaired',
    });
    const siblingDecision = await world.stateManager.recordOwnerDecision(sibling.candidateId, siblingIntent);
    expect(siblingDecision.status).toBe('appended');

    setPersistedKind(world, invalid.candidateId, 'wizardry');
    await runPostProcessing(world, { taskId, output }, 'pain-mixed-recovery');
    await expectSavedRefusal(world, invalid.candidateId, 'candidate_kind_invalid:wizardry');

    // Keep the second candidate parked in the same succeeded diagnosis task.
    const siblingParked = await world.stateManager.updateAdmissionProcessing(sibling.candidateId, {
      state: 'awaiting_owner',
      attempts: 0,
      blockedReason: 'reuse_pending_owner',
    });
    expect(siblingParked).toBe(true);

    setPersistedKind(world, invalid.candidateId, 'principle');
    const authorization = {
      ownerId: 'owner-recovery-test',
      identitySource: 'file',
      reason: 'Restored the intended principle kind from the source recommendation',
      authorizedAt: new Date().toISOString(),
    };
    const authorized = await world.stateManager.authorizeInvalidKindPostProcessingRecovery(invalid.candidateId, authorization);
    expect(authorized.status).toBe('authorized');

    await restartWorker(world);
    const resumed = await world.bridge.resumeSucceededDiagnosisPostProcessing({ taskId });
    expect(resumed.status).toBe('resumed');
    expect(resumed.processedCandidateIds).toEqual([invalid.candidateId]);
    expect(resumed.result?.candidateIds).toEqual([invalid.candidateId]);
    expect(resumed.skipped).toContainEqual({ candidateId: sibling.candidateId, reason: 'processing_awaiting_owner' });

    expect((await candidateOf(world, invalid.candidateId)).status).toBe('consumed');
    expect((await processingOf(world, invalid.candidateId))?.state).toBe('complete');
    expect(await dreamerTasksFor(world, invalid.candidateId)).toHaveLength(1);

    expect((await candidateOf(world, sibling.candidateId)).status).toBe('pending');
    expect(await processingOf(world, sibling.candidateId)).toMatchObject({
      state: 'awaiting_owner',
      blockedReason: 'reuse_pending_owner',
    });
    expect(await dreamerTasksFor(world, sibling.candidateId)).toEqual([]);
  });


  it('allows explicit Owner recovery of a legacy consumed row only when it still has the invalid-kind awaiting_owner park', async () => {
    const world = await createWorld();
    const { taskId, output, candidates } = await commitDiagnosis(world, 'pain-legacy-consumed', ['principle']);
    const [candidate] = candidates;
    if (!candidate) throw new Error('no candidate');
    setPersistedKind(world, candidate.candidateId, 'wizardry');
    await runPostProcessing(world, { taskId, output }, 'pain-legacy-consumed');
    await expectSavedRefusal(world, candidate.candidateId, 'candidate_kind_invalid:wizardry');

    // Simulate the pre-fix path that marked the row consumed despite the
    // durable invalid-kind processing park.
    expect(await world.stateManager.updateCandidateStatus(candidate.candidateId, { status: 'consumed' })).toBe(true);
    setPersistedKind(world, candidate.candidateId, 'principle');

    const authorization = {
      ownerId: 'owner-recovery-test',
      identitySource: 'file',
      reason: 'Restore a legacy invalid-kind candidate after confirming the source recommendation',
      authorizedAt: new Date().toISOString(),
    };
    const recovered = await world.stateManager.authorizeInvalidKindPostProcessingRecovery(candidate.candidateId, authorization);
    expect(recovered.status).toBe('authorized');
    if (recovered.status === 'refused') throw new Error(recovered.reason);
    expect(recovered.document.processing?.state).toBe('in_progress');

    await restartWorker(world);
    const backlog = await world.stateManager.listDiagnosisPostProcessingBacklog({ limit: 100 });
    expect(backlog.eligible.some((item) => item.candidateId === candidate.candidateId)).toBe(true);
    const resumed = await world.bridge.resumeSucceededDiagnosisPostProcessing({ taskId });
    expect(resumed.status).toBe('resumed');
    expect(await dreamerTasksFor(world, candidate.candidateId)).toHaveLength(1);
  });


});
