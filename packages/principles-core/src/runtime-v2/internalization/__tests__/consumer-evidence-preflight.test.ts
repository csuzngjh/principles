/**
 * PRI-982 (SPEC-PD-IAER-001 FR-02 / FR-04 / T01-store / T10) — consumer
 * evidence preflight unit + real-SQLite integration tests.
 *
 * Drives `preflightArtificerOwnerEvidence` against a REAL temp-workspace
 * SQLite store (createRuntimeStateHandle), covering:
 *
 *   - no Owner selection → owner_evidence_required → atomic needs_human_review
 *     transition (CAS + humanReviewContext in the SAME diagnostic write) with
 *     attemptCount UNTOUCHED and ZERO run rows (FR-02: no model run record for
 *     a pure preflight block);
 *   - valid selection + assembling port → ready verdict, task untouched;
 *   - selection present but assembly fails → invalid_evidence → NHR with the
 *     stable invalid reasonCode;
 *   - port ABSENT → evidence_source_unavailable, task untouched (SPEC §6.2:
 *     an unavailable evidence source must not read as "Owner has not
 *     labeled");
 *   - CAS conflict (concurrent diagnostic mutation between read and write) →
 *     no NHR write, reviewPersisted=false, observable;
 *   - read-back invariant + restart durability of the NHR state.
 *
 * Only the assembly I/O is doubled (the port is injected by the host in
 * production); the state layer is the real production path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createOwnerEvidenceScopeError,
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  type BehaviorExamplePack,
  type OwnerEvidenceSelection,
  type StoreEventEmitter,
  type TelemetryEvent,
} from '../../index.js';
import {
  ARTIFICER_EVIDENCE_NHR_SOURCE_RUN_ID,
  preflightArtificerOwnerEvidence,
} from '../consumer-evidence-preflight.js';

const TASK_ID = 'artificer-preflight-001';
const SCRIBE_TASK_ID = 'scribe-preflight-001';

const dirs: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-preflight-'));
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

const VALID_SELECTION: OwnerEvidenceSelection = {
  sourcePainId: 'pain_001',
  sourceNegativeToolCallId: 42,
  positiveToolCallIds: [7],
  ownerDesiredOutcome: 'block writes outside the workspace',
};

let emitted: TelemetryEvent[] = [];
function collectingEmitter(): StoreEventEmitter {
  const emitter = {
    emitTelemetry: (event: TelemetryEvent) => {
      emitted.push(event);
      return true as const;
    },
  };
  return emitter as unknown as StoreEventEmitter;
}

async function seedArtificerTask(workspaceDir: string, selection?: OwnerEvidenceSelection): Promise<void> {
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
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        ...(selection !== undefined ? { ownerEvidenceSelection: selection } : {}),
      }),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface Fixture {
  workspaceDir: string;
  run: (overrides?: { behaviorEvidencePortError?: Error }) => ReturnType<typeof preflightArtificerOwnerEvidence>;
}

async function makeFixture(selection?: OwnerEvidenceSelection): Promise<Fixture> {
  const workspaceDir = makeWorkspace();
  await seedArtificerTask(workspaceDir, selection);
  const run = (overrides?: { behaviorEvidencePortError?: Error }) =>
    (async () => {
      emitted = [];
      const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
      try {
        const { stateManager } = handle;
        const task = await stateManager.getTask(TASK_ID);
        if (!task) throw new Error('fixture task missing');
        const piTask = hydratePITaskRecord(task);
        if (!piTask) throw new Error('fixture piTask did not hydrate');
        return await preflightArtificerOwnerEvidence({
          taskId: TASK_ID,
          piTask,
          owner: 'test-consumer',
          workspaceDir,
          stateManager,
          eventEmitter: collectingEmitter(),
          behaviorEvidence: {
            assemble: () => {
              if (overrides?.behaviorEvidencePortError !== undefined) {
                throw overrides.behaviorEvidencePortError;
              }
              return VALID_PACK;
            },
          },
        });
      } finally {
        await handle.close().catch(() => undefined);
      }
    })();
  return { workspaceDir, run: (overrides) => run(overrides) };
}

async function readTask(workspaceDir: string) {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    return await handle.stateManager.getTask(TASK_ID);
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

describe('preflightArtificerOwnerEvidence (PRI-982 FR-02/FR-04)', () => {
  it('no selection → owner_evidence_required → NHR, attemptCount untouched, zero run rows', async () => {
    const fixture = await makeFixture(undefined);
    const verdict = await fixture.run();

    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') return;
    expect(verdict.reasonCode).toBe('owner_behavior_examples_required');
    expect(verdict.reviewPersisted).toBe(true);
    expect(verdict.missingFields).toContain('sourcePainId');
    expect(verdict.nextAction).toContain('pd runtime internalization retry --confirm');

    const task = await readTask(fixture.workspaceDir);
    expect(task?.status).toBe('needs_human_review');
    expect(task?.attemptCount).toBe(0);
    const hydrated = task ? hydratePITaskRecord(task) : null;
    expect(hydrated?.humanReviewContext?.reasonCode).toBe('owner_behavior_examples_required');
    expect(hydrated?.humanReviewContext?.sourceRunId).toBe(ARTIFICER_EVIDENCE_NHR_SOURCE_RUN_ID);
    // FR-02: a pure preflight block creates NO run record.
    const runsHandle = await createRuntimeStateHandle({ workspaceDir: fixture.workspaceDir, readonly: false });
    try {
      const runs = await runsHandle.stateManager.getValidRunsByTaskTolerant(TASK_ID);
      expect(runs.runs).toHaveLength(0);
    } finally {
      await runsHandle.close().catch(() => undefined);
    }
    // both telemetry events fired
    expect(emitted.some((e) => e.eventType === 'artificer_evidence_readiness_checked')).toBe(true);
    expect(emitted.some((e) => e.eventType === 'artificer_blocked_on_owner_evidence')).toBe(true);
  });

  it('FR-08: blocked events carry the unified run-correlation block (absent run ids are semantic)', async () => {
    const fixture = await makeFixture(undefined);
    const verdict = await fixture.run();
    expect(verdict.decision).toBe('blocked');

    const checked = emitted.find((e) => e.eventType === 'artificer_evidence_readiness_checked');
    expect(checked).toBeDefined();
    expect(checked?.traceId).toBe(TASK_ID);
    expect(checked?.payload).toMatchObject({
      // FR-08 correlation contract (PRI-984)
      taskId: TASK_ID,
      attemptNumber: 0, // the seeded task's real attemptCount at gate time
      workspace: fixture.workspaceDir,
      agentKind: 'artificer',
      executionMode: 'preflight',
      reasonCode: 'owner_behavior_examples_required',
      // verdict references (unchanged A2 semantics)
      channel: 'code_tool_hook',
      gateStatus: 'owner_evidence_required',
    });
    // Absent run identifiers are SEMANTIC for a pre-lease gate: the consumer
    // cycle drives the preflight on a dry-run wake (no lease → no run row)
    // and no runtime was invoked — no placeholder ids may be fabricated.
    expect(checked?.payload.persistentRunId).toBeUndefined();
    expect(checked?.payload.adapterRunId).toBeUndefined();
    // no pack was assembled on a block → no digest reference
    expect(checked?.payload.evidenceDigestPrefix).toBeUndefined();

    const blocked = emitted.find((e) => e.eventType === 'artificer_blocked_on_owner_evidence');
    expect(blocked).toBeDefined();
    expect(blocked?.payload).toMatchObject({
      taskId: TASK_ID,
      attemptNumber: 0,
      workspace: fixture.workspaceDir,
      agentKind: 'artificer',
      executionMode: 'preflight',
      reasonCode: 'owner_behavior_examples_required',
      reviewPersisted: true,
    });
    expect(blocked?.payload.persistentRunId).toBeUndefined();
    expect(blocked?.payload.adapterRunId).toBeUndefined();
  });

  it('FR-08: ready verdict carries reasonCode status + the bounded evidence digest prefix', async () => {
    const fixture = await makeFixture(VALID_SELECTION);
    const verdict = await fixture.run();
    expect(verdict.decision).toBe('ready');

    const checked = emitted.find((e) => e.eventType === 'artificer_evidence_readiness_checked');
    expect(checked?.payload).toMatchObject({
      taskId: TASK_ID,
      attemptNumber: 0,
      workspace: fixture.workspaceDir,
      agentKind: 'artificer',
      executionMode: 'preflight',
      reasonCode: 'ready', // status when the gate has no failure reason code
      gateStatus: 'ready',
    });
    if (verdict.decision !== 'ready') return;
    // auditable reference without duplicating pack content: first 12 chars of
    // the same digest the readiness verdict produced.
    expect(checked?.payload.evidenceDigestPrefix).toBe(verdict.evidenceHash.slice(0, 12));
  });

  it('valid selection + assembling port → ready verdict, task stays pending, no NHR write', async () => {
    const fixture = await makeFixture(VALID_SELECTION);
    const verdict = await fixture.run();

    expect(verdict.decision).toBe('ready');
    if (verdict.decision !== 'ready') return;
    expect(verdict.pack).toEqual(VALID_PACK);
    expect(verdict.evidenceHash.startsWith('sha256:')).toBe(true);
    expect(verdict.sourcePainId).toBe('pain_001');

    const task = await readTask(fixture.workspaceDir);
    expect(task?.status).toBe('pending');
    expect(emitted.some((e) => e.eventType === 'artificer_evidence_readiness_checked')).toBe(true);
    expect(emitted.some((e) => e.eventType === 'artificer_blocked_on_owner_evidence')).toBe(false);
  });

  it('assembly failure → invalid_evidence → NHR with the stable invalid reasonCode', async () => {
    const fixture = await makeFixture(VALID_SELECTION);
    const verdict = await fixture.run({ behaviorEvidencePortError: new Error('[BehaviorExamplePackAssembler] pain event not found for canonical_pain_id="pain_001"') });

    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') return;
    expect(verdict.reasonCode).toBe('owner_behavior_examples_invalid');
    expect(verdict.reviewPersisted).toBe(true);
    expect(verdict.detail).toContain('pain event not found');

    const task = await readTask(fixture.workspaceDir);
    expect(task?.status).toBe('needs_human_review');
  });

  // ── PRI-980 review P2-1 (SPEC §6.2 case 3): a trajectory-store I/O failure
  // is a STORAGE fault with its own routing — never an owner-fault NHR write.

  it('P2-1: typed evidence_source_error → structured degradation, task stays pending, NO NHR write', async () => {
    const fixture = await makeFixture(VALID_SELECTION);
    const verdict = await fixture.run({
      behaviorEvidencePortError: createOwnerEvidenceScopeError(
        'evidence_source_error',
        '[BehaviorExamplePackAssembler] trajectory store pain lineage read failed (database is locked)',
      ),
    });

    expect(verdict.decision).toBe('evidence_source_error');
    if (verdict.decision !== 'evidence_source_error') return;
    expect(verdict.reason).toBe('evidence_source_error');
    expect(verdict.detail).toContain('database is locked');
    expect(verdict.nextAction).toContain('NOT an Owner evidence fault');

    // §6.2: the fault is preserved verbatim, no owner-fault reasonCode, the
    // task is untouched (wake-eligible → the next cycle retries at zero
    // model cost).
    const task = await readTask(fixture.workspaceDir);
    expect(task?.status).toBe('pending');
    const hydrated = task ? hydratePITaskRecord(task) : null;
    expect(hydrated?.humanReviewContext).toBeUndefined();

    // rc-9 observability: the registered crash-durable blocked event carries
    // the storage reasonCode + nextAction; reviewPersisted=false because
    // nothing was written.
    const blocked = emitted.find((e) => e.eventType === 'artificer_blocked_on_owner_evidence');
    expect(blocked).toBeDefined();
    expect(blocked?.payload).toMatchObject({
      taskId: TASK_ID,
      agentKind: 'artificer',
      executionMode: 'preflight',
      reasonCode: 'evidence_source_error',
      reviewPersisted: false,
    });
    expect(String(blocked?.payload.nextAction)).toContain('NOT an Owner evidence fault');
    // no NHR-write event family side effects
    expect(emitted.some((e) => e.eventType === 'artificer_owner_evidence_attached')).toBe(false);
  });

  it('port absent → evidence_source_unavailable, task untouched, no telemetry events', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, undefined);
    emitted = [];
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      const { stateManager } = handle;
      const task = await stateManager.getTask(TASK_ID);
      const piTask = task ? hydratePITaskRecord(task) : null;
      if (!piTask) throw new Error('fixture piTask did not hydrate');
      const verdict = await preflightArtificerOwnerEvidence({
        taskId: TASK_ID,
        piTask,
        owner: 'test-consumer',
        stateManager,
        eventEmitter: collectingEmitter(),
      });
      expect(verdict.decision).toBe('evidence_source_unavailable');
    } finally {
      await handle.close().catch(() => undefined);
    }
    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('pending');
    expect(emitted).toHaveLength(0);
  });

  it('CAS conflict (concurrent diagnostic mutation) → no NHR write, reviewPersisted=false', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, undefined);
    emitted = [];
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      const { stateManager } = handle;
      const task = await stateManager.getTask(TASK_ID);
      const piTask = task ? hydratePITaskRecord(task) : null;
      if (!piTask) throw new Error('fixture piTask did not hydrate');
      // Concurrent writer wins the race BEFORE the preflight's CAS.
      await stateManager.updateTaskDiagnosticJson(TASK_ID, createPITaskDiagnosticJson({
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        correlationId: 'concurrent-writer',
      }));
      const verdict = await preflightArtificerOwnerEvidence({
        taskId: TASK_ID,
        piTask,
        owner: 'test-consumer',
        stateManager,
        eventEmitter: collectingEmitter(),
        behaviorEvidence: { assemble: () => VALID_PACK },
      });
      expect(verdict.decision).toBe('blocked');
      if (verdict.decision !== 'blocked') return;
      expect(verdict.reviewPersisted).toBe(false);
      // FR-08 absent-branch: a caller without workspace context omits the key
      // (never a placeholder) — the correlation block still identifies task +
      // attempt + agent + mode + reason.
      const blockedEvent = emitted.find((e) => e.eventType === 'artificer_blocked_on_owner_evidence');
      expect(blockedEvent?.payload).toMatchObject({
        taskId: TASK_ID,
        attemptNumber: 0,
        agentKind: 'artificer',
        executionMode: 'preflight',
        reasonCode: 'owner_behavior_examples_required',
      });
      expect(blockedEvent?.payload.workspace).toBeUndefined();
    } finally {
      await handle.close().catch(() => undefined);
    }
    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('pending');
  });

  it('NHR state persists across a consumer restart (read-back + durability)', async () => {
    const fixture = await makeFixture(undefined);
    await fixture.run();
    // Re-open (fresh handle = restart) and verify durability + read-back.
    const handle = await createRuntimeStateHandle({ workspaceDir: fixture.workspaceDir, readonly: false });
    try {
      const task = await handle.stateManager.getTask(TASK_ID);
      expect(task?.status).toBe('needs_human_review');
      const hydrated = task ? hydratePITaskRecord(task) : null;
      expect(hydrated?.humanReviewContext?.reasonCode).toBe('owner_behavior_examples_required');
      expect(hydrated?.humanReviewContext?.detail).toContain('nextAction');
    } finally {
      await handle.close().catch(() => undefined);
    }
  });

  // ── PRI-980 review P1-1: the NHR transition carries the §6.3 STATUS
  // precondition on top of the diagnosticJson CAS. `acquireLease` mutates
  // status/lease/attempt_count but NOT diagnostic_json, so without the status
  // precondition a consumer that read the task before another consumer leased
  // it would NHR-park an actively leased task over its lease holder.

  it('P1-1: actively leased task → NHR write LOSES the race observably (status stays leased, no review context)', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, undefined);
    emitted = [];
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      const { stateManager } = handle;
      // The gate's caller reads the task BEFORE the concurrent lease lands
      // (the stale snapshot the real consumer passes after its dry-run wake).
      const staleTask = await stateManager.getTask(TASK_ID);
      const stalePiTask = staleTask ? hydratePITaskRecord(staleTask) : null;
      if (!stalePiTask) throw new Error('fixture piTask did not hydrate');
      // Concurrent consumer B acquires a REAL lease between A's read and A's
      // CAS: status → leased, lease columns + attempt_count mutated,
      // diagnostic_json byte-identical (the exact P1-1 interleave).
      await stateManager.acquireLease({ taskId: TASK_ID, owner: 'consumer-b', runtimeKind: 'claude-cli' });
      const verdict = await preflightArtificerOwnerEvidence({
        taskId: TASK_ID,
        piTask: stalePiTask,
        owner: 'consumer-a',
        stateManager,
        eventEmitter: collectingEmitter(),
        behaviorEvidence: { assemble: () => VALID_PACK },
      });
      expect(verdict.decision).toBe('blocked');
      if (verdict.decision !== 'blocked') return;
      expect(verdict.reasonCode).toBe('owner_behavior_examples_required');
      expect(verdict.reviewPersisted).toBe(false); // observable lost race (rc-9)
      const blockedEvent = emitted.find((e) => e.eventType === 'artificer_blocked_on_owner_evidence');
      expect(blockedEvent?.payload).toMatchObject({ reviewPersisted: false });
    } finally {
      await handle.close().catch(() => undefined);
    }
    // Zero NHR effect over the lease holder: status/lease untouched, no
    // humanReviewContext, diagnostic_json unchanged.
    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('leased');
    expect(task?.leaseOwner).toBe('consumer-b');
    const hydrated = task ? hydratePITaskRecord(task) : null;
    expect(hydrated?.humanReviewContext).toBeUndefined();
  });

  it('P1-1: retry_wait wake-eligible source still parks in NHR (status precondition covers the full wake scan)', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, undefined);
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      const { stateManager } = handle;
      // findCandidates scans pending AND retry_wait; a retry_wait task is a
      // legal preflight input, so its NHR write must NOT lose the new
      // precondition.
      await stateManager.updateTask(TASK_ID, { status: 'retry_wait' });
      const task = await stateManager.getTask(TASK_ID);
      const piTask = task ? hydratePITaskRecord(task) : null;
      if (!piTask) throw new Error('fixture piTask did not hydrate');
      const verdict = await preflightArtificerOwnerEvidence({
        taskId: TASK_ID,
        piTask,
        owner: 'test-consumer',
        stateManager,
        eventEmitter: collectingEmitter(),
        behaviorEvidence: { assemble: () => VALID_PACK },
      });
      expect(verdict.decision).toBe('blocked');
      if (verdict.decision !== 'blocked') return;
      expect(verdict.reviewPersisted).toBe(true);
      const after = await stateManager.getTask(TASK_ID);
      expect(after?.status).toBe('needs_human_review');
    } finally {
      await handle.close().catch(() => undefined);
    }
  });
});
