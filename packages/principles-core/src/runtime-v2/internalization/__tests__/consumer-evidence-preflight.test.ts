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
});
