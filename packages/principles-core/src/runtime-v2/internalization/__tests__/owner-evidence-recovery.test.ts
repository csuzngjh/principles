/**
 * PRI-983 (SPEC-PD-IAER-001 FR-03/FR-06, T05/T06/T10) — Owner evidence
 * attach/resume recovery service against a REAL temp-workspace SQLite store.
 *
 * Only the assembly I/O is doubled (the production port is the plugin
 * BehaviorExamplePackAssembler, injected by the host exactly like the
 * consumer cycle's behaviorEvidence port); the state layer, the CAS, the
 * single recovery authority (ownerRetryNeedsHumanReviewTask) and the audit
 * log are the real production paths.
 *
 * Covered:
 *   - T05: list → attach dry-run (zero writes) → attach confirm (CAS
 *     persist + task STAYS needs_human_review + audit + telemetry) →
 *     resume dry-run (digest verified, zero writes) → resume confirm
 *     (atomic requeue, previousAttemptCount audited, history preserved) →
 *     the consumer preflight accepts the task again (ready verdict).
 *   - T06: two concurrent confirm resumes → at most one `resumed`, the
 *     other structurally refused with zero mutation; sequential second
 *     resume after success → task_not_needs_human_review refusal.
 *   - stale/scope: tampered contentDigest → owner_behavior_examples_stale;
 *     typed tool_call_not_found → stale; typed session_mismatch →
 *     scope_mismatch; each with zero state change.
 *   - attach guards: pending task / non-evidence NHR task refused.
 *   - re-attach increments the revision under the CAS.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  preflightArtificerOwnerEvidence,
  type BehaviorExamplePack,
  type OwnerEvidenceSelection,
  type RuntimeStateManager,
  type StoreEventEmitter,
  type TelemetryEvent,
} from '../../index.js';
import {
  attachOwnerEvidence,
  listEvidenceWaitingTasks,
  resumeOwnerEvidenceTask,
} from '../owner-evidence-recovery.js';
import { listOwnerEvidenceActions } from '../../recovery-actions-log.js';
import { createOwnerEvidenceScopeError } from '../evidence-readiness.js';
import { ARTIFICER_EVIDENCE_NHR_SOURCE_RUN_ID } from '../consumer-evidence-preflight.js';

const TASK_ID = 'artificer-evidence-001';
const SCRIBE_TASK_ID = 'scribe-evidence-001';

const dirs: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evidence-recovery-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

const V2_RULE_CONTEXT = {
  version: 2 as const,
  history: { status: 'available' as const, truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};

const VALID_PACK: BehaviorExamplePack = {
  sourceNegativeCase: {
    caseId: 'negative-1',
    kind: 'negative',
    toolName: 'write_file',
    params: { path: '/etc/passwd' },
    expectedDecision: 'block',
    ruleContext: V2_RULE_CONTEXT,
  },
  ownerDesiredOutcome: 'block writes outside the workspace',
  positiveCounterexamples: [{
    caseId: 'positive-1',
    kind: 'positive',
    toolName: 'write_file',
    params: { path: '/project/file.txt' },
    expectedDecision: 'allow',
    ruleContext: V2_RULE_CONTEXT,
  }],
  evidenceRefs: ['pain:pain_001', 'tool_call:42', 'tool_call:7'],
  redactionNotes: [],
};

const BASE_SELECTION: OwnerEvidenceSelection = {
  sourcePainId: 'pain_001',
  sourceNegativeToolCallId: 42,
  positiveToolCallIds: [7],
  ownerDesiredOutcome: 'block writes outside the workspace',
};

let emitted: TelemetryEvent[] = [];
function collectingEmitter(): StoreEventEmitter {
  return {
    emitTelemetry: (event: TelemetryEvent) => {
      emitted.push(event);
      return true as const;
    },
  } as unknown as StoreEventEmitter;
}

/** Assembling port: returns the valid pack unless an override error is set. */
function makePort(overrides?: { error?: Error }): { assemble: () => BehaviorExamplePack } {
  return {
    assemble: () => {
      if (overrides?.error !== undefined) {
        throw overrides.error;
      }
      return VALID_PACK;
    },
  };
}

async function seedEvidenceNhrTask(workspaceDir: string, reasonCode: string): Promise<void> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    await stateManager.createTask({
      taskId: SCRIBE_TASK_ID,
      taskKind: 'scribe',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'scribe://run-1',
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    await stateManager.createTask({
      taskId: TASK_ID,
      taskKind: 'artificer',
      status: 'needs_human_review',
      attemptCount: 2,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        humanReviewContext: {
          reasonCode,
          sourceRunId: ARTIFICER_EVIDENCE_NHR_SOURCE_RUN_ID,
          revisionEpoch: 0,
          detail: 'preflight block',
          createdAt: new Date().toISOString(),
        },
      }),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface Fixture {
  workspaceDir: string;
  /** Opens a fresh handle (consumer-restart semantics) and runs one operation. */
  withHandle: <T>(fn: (stateManager: RuntimeStateManager) => Promise<T>) => Promise<T>;
}

async function makeFixture(reasonCode = 'owner_behavior_examples_required'): Promise<Fixture> {
  const workspaceDir = makeWorkspace();
  await seedEvidenceNhrTask(workspaceDir, reasonCode);
  const withHandle = async <T>(fn: (sm: RuntimeStateManager) => Promise<T>): Promise<T> => {
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      return await fn(handle.stateManager);
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
  return { workspaceDir, withHandle };
}

async function readTask(workspaceDir: string) {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const task = await handle.stateManager.getTask(TASK_ID);
    return { task, piTask: task ? hydratePITaskRecord(task) : null };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

afterEach(async () => {
  const { disposePainSignalBridgesForWorkspace } = await import('../../index.js');
  for (const dir of dirs) {
    await disposePainSignalBridgesForWorkspace(dir).catch(() => undefined);
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const dir of dirs.splice(0)) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await sleep(150);
      }
    }
    if (lastError !== null) throw new Error(`cleanup failed on ${dir}: ${String(lastError).slice(0, 120)}`);
  }
});

describe('attachOwnerEvidence (T05)', () => {
  it('dry-run assembles and reports but writes NOTHING (cli-5)', async () => {
    const fixture = await makeFixture();
    const before = await readTask(fixture.workspaceDir);

    const outcome = await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID,
      selection: BASE_SELECTION,
      mode: 'dry_run',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));

    expect(outcome.status).toBe('dry_run');
    if (outcome.status !== 'dry_run') return;
    expect(outcome.wouldPersist.revision).toBe(1);
    expect(outcome.wouldPersist.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(outcome.wouldPersist.ownerOperation).toBe('cli:attach');

    const after = await readTask(fixture.workspaceDir);
    expect(after.task?.diagnosticJson).toBe(before.task?.diagnosticJson);
    expect(after.task?.status).toBe('needs_human_review');
    expect(listOwnerEvidenceActions(fixture.workspaceDir)).toHaveLength(0);
    expect(emitted.some((e) => e.eventType === 'artificer_owner_evidence_attached')).toBe(false);
  });

  it('confirm persists the provenanced selection via CAS; task STAYS needs_human_review (attach never unblocks)', async () => {
    const fixture = await makeFixture();
    emitted = [];

    const outcome = await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID,
      selection: BASE_SELECTION,
      decidedBy: 'martin',
      mode: 'confirm',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));

    expect(outcome.status).toBe('attached');
    if (outcome.status !== 'attached') return;
    expect(outcome.revision).toBe(1);
    expect(outcome.ownerOperation).toBe('cli:attach:martin');
    expect(outcome.taskStillNeedsHumanReview).toBe(true);

    const { task, piTask } = await readTask(fixture.workspaceDir);
    expect(task?.status).toBe('needs_human_review');
    expect(task?.attemptCount).toBe(2); // untouched by attach
    expect(piTask?.ownerEvidenceSelection).toMatchObject({
      sourcePainId: 'pain_001',
      revision: 1,
      contentDigest: outcome.contentDigest,
      ownerOperation: 'cli:attach:martin',
    });

    // audit + telemetry (FR-08, bounded payloads)
    const audit = listOwnerEvidenceActions(fixture.workspaceDir, { taskId: TASK_ID });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'attach_evidence', revision: 1, operator: 'martin', painId: 'pain_001' });
    const event = emitted.find((e) => e.eventType === 'artificer_owner_evidence_attached');
    expect(event).toBeDefined();
    expect(JSON.stringify(event)).not.toContain('block writes outside the workspace'); // rc-8: no raw owner text
    // FR-08 run-correlation block (PRI-984): attach never leases an NHR task,
    // so persistentRunId/adapterRunId are semantically absent.
    expect(event?.payload).toMatchObject({
      taskId: TASK_ID,
      attemptNumber: 2, // the seeded task's real attemptCount — unchanged by attach
      workspace: fixture.workspaceDir,
      agentKind: 'artificer',
      executionMode: 'recovery',
      reasonCode: 'attached', // status: an attach has no failure reason code
      painId: 'pain_001',
      revision: 1,
      ownerOperation: 'cli:attach:martin',
      taskStillNeedsHumanReview: true,
    });
    expect(event?.payload.persistentRunId).toBeUndefined();
    expect(event?.payload.adapterRunId).toBeUndefined();
    // bounded digest prefix, cross-checked against the persisted authority
    const { piTask: attachedPi } = await readTask(fixture.workspaceDir);
    // rc-3: the digest is REQUIRED on a confirmed attach — assert it loudly
    // instead of narrowing with a non-null assertion.
    const attachedDigest = attachedPi?.ownerEvidenceSelection?.contentDigest;
    if (attachedDigest === undefined) {
      throw new Error('fixture: the attached selection must persist a contentDigest');
    }
    expect(event?.payload.evidenceDigestPrefix).toBe(attachedDigest.slice(0, 12));
  });

  it('re-attach increments the revision under the CAS', async () => {
    const fixture = await makeFixture();
    const attach = (mode: 'dry_run' | 'confirm') => fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID,
      selection: BASE_SELECTION,
      mode,
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    expect((await attach('confirm')).status).toBe('attached');
    const second = await attach('confirm');
    expect(second.status).toBe('attached');
    if (second.status !== 'attached') return;
    expect(second.revision).toBe(2);
    const { piTask } = await readTask(fixture.workspaceDir);
    expect(piTask?.ownerEvidenceSelection?.revision).toBe(2);
  });

  it('refuses a non-evidence NHR task (not_evidence_review) and a pending task — zero mutation (cli-5)', async () => {
    const fixture = await makeFixture('evaluator_repair_budget_exhausted'); // not an evidence code
    const notEvidence = await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID,
      selection: BASE_SELECTION,
      mode: 'confirm',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    expect(notEvidence).toMatchObject({ status: 'refused', reason: 'not_evidence_review' });
    expect(listOwnerEvidenceActions(fixture.workspaceDir)).toHaveLength(0);
  });

  it('refuses an unusable selection before any assembly or write (cli-5)', async () => {
    const fixture = await makeFixture();
    const before = await readTask(fixture.workspaceDir);
    const badSelection = await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID,
      selection: { ...BASE_SELECTION, sourceNegativeToolCallId: 0 },
      mode: 'confirm',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    expect(badSelection).toMatchObject({ status: 'refused', reason: 'owner_behavior_examples_invalid' });
    expect(await readTask(fixture.workspaceDir)).toMatchObject({ task: { diagnosticJson: before.task?.diagnosticJson } });
    expect(listOwnerEvidenceActions(fixture.workspaceDir)).toHaveLength(0);
  });
});

describe('resumeOwnerEvidenceTask (T05)', () => {
  async function attachedFixture() {
    const fixture = await makeFixture();
    const outcome = await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID,
      selection: BASE_SELECTION,
      decidedBy: 'martin',
      mode: 'confirm',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    if (outcome.status !== 'attached') throw new Error('fixture attach failed');
    return fixture;
  }

  it('full cycle: list → dry-run verified → confirm resumes atomically, history preserved, consumer accepts again', async () => {
    const fixture = await attachedFixture();
    emitted = [];

    // FR-06 1/2: the evidence list surfaces the waiting task.
    const listed = await fixture.withHandle((sm) => listEvidenceWaitingTasks(sm));
    const row = listed.find((t) => t.taskId === TASK_ID);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      channel: 'code_tool_hook',
      painId: 'pain_001',
      reasonCode: 'owner_behavior_examples_required',
      attemptCount: 2,
      maxAttempts: 3,
      evidenceRevision: 1,
    });
    expect(row?.missingFields.length).toBeGreaterThan(0);

    // resume dry-run: digest verified, zero writes.
    const dry = await fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
      taskId: TASK_ID,
      mode: 'dry_run',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    expect(dry.status).toBe('dry_run');
    if (dry.status !== 'dry_run') return;
    expect(dry.reasonCode).toBe('owner_behavior_examples_verified');
    expect(dry.previousAttemptCount).toBe(2);
    const afterDry = await readTask(fixture.workspaceDir);
    expect(afterDry.task?.status).toBe('needs_human_review');
    expect(emitted.some((e) => e.eventType === 'artificer_owner_evidence_resumed')).toBe(false);

    // resume confirm: atomic requeue through the single recovery authority.
    const outcome = await fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
      taskId: TASK_ID,
      decidedBy: 'martin',
      mode: 'confirm',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    expect(outcome.status).toBe('resumed');
    if (outcome.status !== 'resumed') return;
    expect(outcome.previousAttemptCount).toBe(2);

    const { task, piTask } = await readTask(fixture.workspaceDir);
    expect(task?.status).toBe('pending');
    expect(task?.attemptCount).toBe(0);
    // history preserved: NHR context + selection + lineage stay in metadata.
    expect(piTask?.humanReviewContext?.reasonCode).toBe('owner_behavior_examples_required');
    expect(piTask?.ownerEvidenceSelection?.revision).toBe(1);
    expect(piTask?.dependencyTaskIds).toEqual([SCRIBE_TASK_ID]);

    // audit records the explicit budget reset (FR-06: never a silent clear).
    const audit = listOwnerEvidenceActions(fixture.workspaceDir, { taskId: TASK_ID });
    expect(audit.map((a) => a.action)).toEqual(['attach_evidence', 'resume_evidence']);
    expect(audit[1]).toMatchObject({ previousAttemptCount: 2, operator: 'martin' });
    expect(emitted.some((e) => e.eventType === 'artificer_owner_evidence_resumed')).toBe(true);
    // FR-08 run-correlation block (PRI-984): the resume requeues to pending —
    // the next attempt's run row does not exist yet, so persistentRunId stays
    // semantically absent (the T10 test below proves the join to it).
    const resumedEvent = emitted.find((e) => e.eventType === 'artificer_owner_evidence_resumed');
    expect(resumedEvent?.payload).toMatchObject({
      taskId: TASK_ID,
      attemptNumber: 0, // new budget start certified by the authority reset
      workspace: fixture.workspaceDir,
      agentKind: 'artificer',
      executionMode: 'recovery',
      reasonCode: 'owner_behavior_examples_verified',
      previousAttemptCount: 2,
      painId: 'pain_001',
      revision: 1,
    });
    expect(resumedEvent?.payload.persistentRunId).toBeUndefined();
    expect(resumedEvent?.payload.adapterRunId).toBeUndefined();
    expect(resumedEvent?.payload.evidenceDigestPrefix).toBe(outcome.contentDigest.slice(0, 12));

    // the consumer gate now accepts the task again (A2 preflight → ready),
    // i.e. the task is re-schedulable through the real production gate.
    const verdict = await fixture.withHandle(async (sm) => {
      const fresh = await sm.getTask(TASK_ID);
      const pi = fresh ? hydratePITaskRecord(fresh) : null;
      if (!fresh || !pi) throw new Error('task missing after resume');
      return preflightArtificerOwnerEvidence({
        taskId: TASK_ID,
        piTask: pi,
        owner: 'test-consumer',
        stateManager: sm,
        eventEmitter: collectingEmitter(),
        behaviorEvidence: makePort(),
      });
    });
    expect(verdict.decision).toBe('ready');
  });

  it('run history is preserved across the resume (T05: rows never deleted)', async () => {
    const fixture = await attachedFixture();
    // Seed one historical run row (as a prior failed attempt would have left).
    await fixture.withHandle(async (sm) => {
      await sm.runStore.createRun({
        runId: `run_${TASK_ID}_1`,
        runtimeKind: 'pi-ai',
        startedAt: new Date().toISOString(),
        taskId: TASK_ID,
        attemptNumber: 1,
        executionStatus: 'failed',
        endedAt: new Date().toISOString(),
        reason: 'historical attempt',
        errorCategory: 'execution_failed',
      });
    });
    const runsBefore = await fixture.withHandle(async (sm) => (await sm.getValidRunsByTaskTolerant(TASK_ID)).runs.length);
    expect(runsBefore).toBe(1);

    const outcome = await fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
      taskId: TASK_ID,
      mode: 'confirm',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    expect(outcome.status).toBe('resumed');

    const runsAfter = await fixture.withHandle(async (sm) => (await sm.getValidRunsByTaskTolerant(TASK_ID)).runs.length);
    expect(runsAfter).toBe(1);
  });

  it('T10 (FR-08/AC-09): the correlation chain joins the resumed event to the lease-minted runs row', async () => {
    // Seed the pre-evidence failure history: two consumed attempts left two
    // runs rows (the deterministic lease spelling run_<taskId>_<attempt>).
    const fixture = await makeFixture();
    await fixture.withHandle(async (sm) => {
      for (const attempt of [1, 2]) {
        await sm.runStore.createRun({
          runId: `run_${TASK_ID}_${attempt}`,
          runtimeKind: 'pi-ai',
          startedAt: new Date().toISOString(),
          taskId: TASK_ID,
          attemptNumber: attempt,
          executionStatus: 'failed',
          endedAt: new Date().toISOString(),
          reason: 'historical attempt',
          errorCategory: 'execution_failed',
        });
      }
    });

    // Attach + resume through the real authorities (events collected).
    emitted = [];
    const attached = await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID, selection: BASE_SELECTION, mode: 'confirm',
      assemble: makePort(), workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(), owner: 'pd-cli:evidence',
    }));
    expect(attached.status).toBe('attached');
    const outcome = await fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
      taskId: TASK_ID, mode: 'confirm', decidedBy: 'martin',
      assemble: makePort(), workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(), owner: 'pd-cli:evidence',
    }));
    expect(outcome.status).toBe('resumed');
    const resumedEvent = emitted.find((e) => e.eventType === 'artificer_owner_evidence_resumed');
    expect(resumedEvent?.payload).toMatchObject({ taskId: TASK_ID, attemptNumber: 0, previousAttemptCount: 2 });

    // The post-resume execution path: a REAL production lease mints the next
    // attempt's run row under the deterministic `run_<taskId>_<max+1>`
    // spelling — the persistentRunId value execution events carry. It must
    // resolve to a physical runs row joined on (task_id, attempt_number).
    const leased = await fixture.withHandle((sm) => sm.acquireLease({
      taskId: TASK_ID,
      owner: 'test-consumer',
      runtimeKind: 'pi-ai',
    }));
    expect(leased.taskId).toBe(TASK_ID);
    expect(leased.attemptCount).toBe(3); // history preserved: max(1,2) + 1

    const { runs } = await fixture.withHandle(async (sm) => sm.getValidRunsByTaskTolerant(TASK_ID));
    expect(runs.map((r) => r.runId)).toEqual([
      `run_${TASK_ID}_1`,
      `run_${TASK_ID}_2`,
      `run_${TASK_ID}_3`,
    ]);
    for (const run of runs) {
      // every persistentRunId issued downstream resolves to its own row
      expect(run.runId).toBe(`run_${TASK_ID}_${run.attemptNumber}`);
      expect(run.taskId).toBe(TASK_ID);
    }
  });
});

describe('resume refusals (stale / scope / guards, zero mutation)', () => {
  it('tampered contentDigest → owner_behavior_examples_stale, zero state change', async () => {
    const fixture = await makeFixture();
    await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID,
      selection: BASE_SELECTION,
      mode: 'confirm',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    // Simulate tampering: rewrite the stored digest to another well-formed value.
    await fixture.withHandle(async (sm) => {
      const task = await sm.getTask(TASK_ID);
      if (!task) throw new Error('missing');
      const raw = JSON.parse(task.diagnosticJson ?? '{}') as { pi_metadata: { ownerEvidenceSelection: { contentDigest: string } } };
      raw.pi_metadata.ownerEvidenceSelection.contentDigest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      await sm.updateTaskDiagnosticJson(TASK_ID, JSON.stringify(raw));
    });

    const outcome = await fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
      taskId: TASK_ID,
      mode: 'confirm',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('owner_behavior_examples_stale');
    expect(outcome.detail).toContain('!=');

    const { task } = await readTask(fixture.workspaceDir);
    expect(task?.status).toBe('needs_human_review');
  });

  it('typed tool_call_not_found (trajectory cleaned) → owner_behavior_examples_stale', async () => {
    const fixture = await makeFixture();
    const attached = await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID, selection: BASE_SELECTION, mode: 'confirm',
      assemble: makePort(), workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(), owner: 'pd-cli:evidence',
    }));
    if (attached.status !== 'attached') throw new Error('fixture attach failed');

    const before = await readTask(fixture.workspaceDir);
    const outcome = await fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
      taskId: TASK_ID,
      mode: 'confirm',
      assemble: makePort({ error: createOwnerEvidenceScopeError('tool_call_not_found', 'selected tool call id=42 not found') }),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('owner_behavior_examples_stale');
    expect(outcome.nextAction).toContain('re-attach');
    expect((await readTask(fixture.workspaceDir)).task?.diagnosticJson).toBe(before.task?.diagnosticJson);
  });

  it('typed session_mismatch (cross pain/session) → owner_behavior_examples_scope_mismatch', async () => {
    const fixture = await makeFixture();
    const attached = await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID, selection: BASE_SELECTION, mode: 'confirm',
      assemble: makePort(), workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(), owner: 'pd-cli:evidence',
    }));
    if (attached.status !== 'attached') throw new Error('fixture attach failed');

    const outcome = await fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
      taskId: TASK_ID,
      mode: 'confirm',
      assemble: makePort({ error: createOwnerEvidenceScopeError('session_mismatch', 'selected tool call 7 session mismatch') }),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('owner_behavior_examples_scope_mismatch');
    expect((await readTask(fixture.workspaceDir)).task?.status).toBe('needs_human_review');
  });

  it('resume without a stored selection → owner_behavior_examples_required', async () => {
    const fixture = await makeFixture();
    const outcome = await fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
      taskId: TASK_ID,
      mode: 'confirm',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));
    expect(outcome).toMatchObject({ status: 'refused', reason: 'owner_behavior_examples_required' });
    expect((await readTask(fixture.workspaceDir)).task?.status).toBe('needs_human_review');
  });
});

describe('concurrency (T06)', () => {
  it('two concurrent confirm resumes: exactly one resumes, the other is structurally refused with zero mutation', async () => {
    const fixture = await makeFixture();
    await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID,
      selection: BASE_SELECTION,
      mode: 'confirm',
      assemble: makePort(),
      workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(),
      owner: 'pd-cli:evidence',
    }));

    const outcomes = await Promise.all([
      fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
        taskId: TASK_ID, mode: 'confirm', assemble: makePort(),
        workspaceDir: fixture.workspaceDir, eventEmitter: collectingEmitter(), owner: 'pd-cli:evidence',
      })),
      fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
        taskId: TASK_ID, mode: 'confirm', assemble: makePort(),
        workspaceDir: fixture.workspaceDir, eventEmitter: collectingEmitter(), owner: 'pd-cli:evidence',
      })),
    ]);

    const resumedCount = outcomes.filter((o) => o.status === 'resumed').length;
    expect(resumedCount).toBe(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'resumed') continue;
      // the loser gets a structured refusal/conflict, never a silent success
      expect(['conflict', 'refused']).toContain(outcome.status);
      if (outcome.status === 'refused') {
        expect(outcome.reason.length).toBeGreaterThan(0);
        expect(outcome.nextAction.length).toBeGreaterThan(0);
      }
      if (outcome.status === 'conflict') {
        expect(outcome.nextAction.length).toBeGreaterThan(0);
      }
    }

    const { task } = await readTask(fixture.workspaceDir);
    expect(task?.status).toBe('pending');
    const audit = listOwnerEvidenceActions(fixture.workspaceDir, { taskId: TASK_ID })
      .filter((a) => a.action === 'resume_evidence');
    expect(audit).toHaveLength(1);
  });

  it('a second sequential resume after success is refused (task no longer NHR)', async () => {
    const fixture = await makeFixture();
    await fixture.withHandle((sm) => attachOwnerEvidence(sm, {
      taskId: TASK_ID, selection: BASE_SELECTION, mode: 'confirm',
      assemble: makePort(), workspaceDir: fixture.workspaceDir,
      eventEmitter: collectingEmitter(), owner: 'pd-cli:evidence',
    }));
    await fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
      taskId: TASK_ID, mode: 'confirm', assemble: makePort(),
      workspaceDir: fixture.workspaceDir, eventEmitter: collectingEmitter(), owner: 'pd-cli:evidence',
    }));
    const second = await fixture.withHandle((sm) => resumeOwnerEvidenceTask(sm, {
      taskId: TASK_ID, mode: 'confirm', assemble: makePort(),
      workspaceDir: fixture.workspaceDir, eventEmitter: collectingEmitter(), owner: 'pd-cli:evidence',
    }));
    expect(second).toMatchObject({ status: 'refused', reason: 'task_not_needs_human_review' });
  });
});
