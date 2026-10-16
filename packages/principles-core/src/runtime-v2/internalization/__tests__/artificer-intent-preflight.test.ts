/**
 * SPEC-RULECODE-QUALITY-001 A1 — artificer intent-basis preflight (Q01 / Q13 /
 * Q14 / Q20 / Q21 / Q22).
 *
 * Unit + real-SQLite integration tests for the PRE-MODEL intent gate that runs
 * BEFORE any Artificer runner construction on the code_tool_hook channel:
 *
 *   Q01  a scribe artifact without the machine-readable execution conditions
 *        (the original pain's legacy chain shape) yields an explicit stop
 *        point (needs_human_review, reasonCode intent_unverified), ZERO
 *        generation calls;
 *   Q20  the gate reads the SCRIBE artifact from the store — a generator that
 *        omits its approval dependency cannot bypass it, and a stale stored
 *        verification record is never a pass token (always re-derived);
 *   Q13  the versioned verification record binds scribe/intent/conditions
 *        digests; a changed scribe artifact invalidates the previous record;
 *   Q14  the NHR transition is CAS-guarded and idempotent — a repeat run
 *        never writes a second review context and never loses history;
 *   Q21  a transient source fault (artifact store I/O) retries technically at
 *        zero model cost with a restart-durable, bounded backoff;
 *   Q22  the 3rd consecutive source fault ends auto-retry with a clear
 *        source-fault terminal state that is NOT labeled an Owner fault.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  type StoreEventEmitter,
  type TelemetryEvent,
} from '../../index.js';
import {
  preflightArtificerIntentBasis,
  consumeSourceFaultBackoffSkip,
  ARTIFICER_INTENT_NHR_SOURCE_RUN_ID,
  type ArtificerTrustedFactsPort,
} from '../artificer-intent-preflight.js';

const TASK_ID = 'artificer-intent-001';
const SCRIBE_TASK_ID = 'scribe-intent-001';

const dirs: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intent-preflight-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

const INTENT_CONTRACT = {
  ownerIntent: 'complex changes must not be implemented before the design is confirmed by the Owner',
  targetBehavior: 'agent pauses complex edits and requests design confirmation first',
  forbiddenBehavior: 'implementing complex changes without a confirmed design',
  evidenceSource: 'pain:manual_1791868470372',
  validationExpectation: 'rule blocks complex-change writes that carry no confirmed-design evidence',
};

/** Scribe artifact WITHOUT executionConditions — the legacy/original-pain shape. */
function legacyScribeContent(): string {
  return JSON.stringify({
    taskId: SCRIBE_TASK_ID,
    sourcePhilosopherArtifactId: 'art-phil-001',
    principleDraft: {
      title: 'Design confirmation before complex changes',
      statement: 'Complex changes require confirmed design before implementation',
      rationale: 'unconfirmed complex edits caused the original pain',
      applicability: ['complex code changes'],
      antiPatterns: ['implementing complex changes without design confirmation'],
      confidence: 0.9,
    },
    sourceTrace: { philosopherArtifactId: 'art-phil-001' },
    risks: [],
    intentContract: INTENT_CONTRACT,
    generatedAt: '2026-10-16T00:00:00.000Z',
  });
}

/** Scribe artifact WITH executionConditions: no trusted external facts required. */
function conditionsScribeContent(requiredFacts: Array<{ factKind: string; required: boolean; textualBasis: string }>): string {
  return JSON.stringify({
    taskId: SCRIBE_TASK_ID,
    sourcePhilosopherArtifactId: 'art-phil-001',
    principleDraft: {
      title: 'Design confirmation before complex changes',
      statement: 'Complex changes require confirmed design before implementation',
      rationale: 'unconfirmed complex edits caused the original pain',
      applicability: ['complex code changes'],
      antiPatterns: ['implementing complex changes without design confirmation'],
      confidence: 0.9,
    },
    sourceTrace: { philosopherArtifactId: 'art-phil-001' },
    risks: [],
    intentContract: INTENT_CONTRACT,
    executionConditions: { version: 1, requiredFacts },
    generatedAt: '2026-10-16T00:00:00.000Z',
  });
}

async function seedArtificerTask(workspaceDir: string, scribeContentJson: string): Promise<string> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    const now = new Date().toISOString();
    await stateManager.createTask({
      taskId: SCRIBE_TASK_ID,
      taskKind: 'scribe',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'scribe://run-1',
      diagnosticJson: JSON.stringify({ sourcePainId: 'pain_001', pi_metadata: {
        dependencyTaskIds: [],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }}),
    });
    const artifactId = `pi-art-${SCRIBE_TASK_ID}-run-1`;
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId,
      artifactKind: 'principle',
      sourceTaskId: SCRIBE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: scribeContentJson,
      createdAt: now,
      updatedAt: now,
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
      }),
    });
    return artifactId;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

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

interface RunOverrides {
  trustedFacts?: ArtificerTrustedFactsPort;
  artifactStoreFault?: Error;
}

async function runPreflight(workspaceDir: string, overrides: RunOverrides = {}) {
  emitted = [];
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    const task = await stateManager.getTask(TASK_ID);
    if (!task) throw new Error('fixture task missing');
    const piTask = hydratePITaskRecord(task);
    if (!piTask) throw new Error('fixture piTask did not hydrate');
    return await preflightArtificerIntentBasis({
      taskId: TASK_ID,
      piTask,
      owner: 'test-consumer',
      workspaceDir,
      stateManager,
      eventEmitter: collectingEmitter(),
      ...(overrides.trustedFacts !== undefined ? { trustedFacts: overrides.trustedFacts } : {}),
      ...(overrides.artifactStoreFault !== undefined
        ? { artifactStore: { listBySourceTaskId: async () => { throw overrides.artifactStoreFault; } } }
        : {}),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
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
      } catch (err) {
        lastError = err;
        await sleep(50);
      }
    }
    if (lastError !== null) throw lastError;
  }
});

describe('preflightArtificerIntentBasis — stop points (Q01/Q20)', () => {
  it('Q01 legacy scribe artifact (no executionConditions) stops at needs_human_review with zero generation', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, legacyScribeContent());

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('intent_unverified');
    expect(verdict.reasonCode).toBe('execution_conditions_missing');
    expect(verdict.nextAction).toContain('pd runtime internalization retry --confirm');

    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
    const piTask = task ? hydratePITaskRecord(task) : null;
    expect(piTask?.humanReviewContext?.reasonCode).toBe('execution_conditions_missing');
    expect(piTask?.humanReviewContext?.sourceRunId).toBe(ARTIFICER_INTENT_NHR_SOURCE_RUN_ID);
    // Zero generation: no run rows for this task (the runner was never constructed).
    expect(emitted.some((event) => event.eventType === 'artificer_intent_basis_checked')).toBe(true);
  });

  it('Q01 a scribe artifact declaring a required design-approval fact with no trusted-facts port stops as unsupported (host capability gap)', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      { factKind: 'design_approval', required: true, textualBasis: 'complex changes require confirmed design before implementation' },
    ]));

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('unsupported');
    expect(verdict.reasonCode).toBe('trusted_fact_provider_absent');
    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
  });

  it('a trusted-facts port resolving the fact to unknown stops as needs_evidence (capability present, fact pending)', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      { factKind: 'design_approval', required: true, textualBasis: 'complex changes require confirmed design before implementation' },
    ]));
    const verdict = await runPreflight(workspaceDir, {
      trustedFacts: { resolveRequiredFact: () => ({ resolution: 'unknown' }) },
    });
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('needs_evidence');
    expect(verdict.reasonCode).toBe('trusted_fact_unknown');
    await expect(readTask(workspaceDir)).resolves.toMatchObject({ status: 'needs_human_review' });
  });

  it('malformed executionConditions stops as intent_unverified (corrupted anchor fails loud)', async () => {
    const workspaceDir = makeWorkspace();
    const corrupted = JSON.parse(conditionsScribeContent([])) as Record<string, unknown>;
    corrupted.executionConditions = { version: 1, requiredFacts: 'not-an-array' };
    await seedArtificerTask(workspaceDir, JSON.stringify(corrupted));

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('intent_unverified');
    expect(verdict.reasonCode).toBe('execution_conditions_invalid');
  });

  it('contradictory duplicate required-fact declarations stop as intent_conflict', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      { factKind: 'design_approval', required: true, textualBasis: 'design must be confirmed' },
      { factKind: 'design_approval', required: false, textualBasis: 'design need not be confirmed' },
    ]));
    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('intent_conflict');
    expect(verdict.reasonCode).toBe('required_fact_conflict');
  });
});

describe('preflightArtificerIntentBasis — executable path (Q13/Q20)', () => {
  it('no required facts → executable, and the versioned record binds material digests', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('executable');
    if (verdict.decision !== 'executable') throw new Error('unreachable');
    expect(verdict.record.version).toBe(1);
    expect(verdict.record.checkedBy).toBe('deterministic-preflight');
    expect(verdict.record.sourceScribeArtifactId).toBeTruthy();
    expect(verdict.record.scribeArtifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verdict.record.executionConditionsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verdict.record.requiredFacts).toEqual([]);

    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('pending'); // untouched — generation may proceed
  });

  it('Q13/Q20 a previously stored record never acts as a pass token: the gate re-derives from the scribe artifact every run', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));
    const first = await runPreflight(workspaceDir);
    expect(first.decision).toBe('executable');

    // Tamper the scribe artifact to the legacy shape AFTER a pass was recorded.
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      const artifacts = await handle.stateManager.piArtifactStore.listBySourceTaskId(SCRIBE_TASK_ID);
      const artifactId = artifacts[0]?.artifactId;
      if (!artifactId) throw new Error('scribe artifact missing');
      const now = new Date().toISOString();
      await handle.stateManager.piArtifactStore.upsertArtifact({
        artifactId,
        artifactKind: 'principle',
        sourceTaskId: SCRIBE_TASK_ID,
        lineageArtifactIds: [],
        validationStatus: 'validated',
        contentJson: legacyScribeContent(),
        createdAt: now,
        updatedAt: now,
      });
    } finally {
      await handle.close().catch(() => undefined);
    }

    const second = await runPreflight(workspaceDir);
    expect(second.decision).toBe('blocked'); // stale pass evidence invalidated by the material change
    if (second.decision !== 'blocked') throw new Error('unreachable');
    expect(second.logicalResult).toBe('intent_unverified');
    expect(second.reasonCode).toBe('execution_conditions_missing');
  });
});

describe('preflightArtificerIntentBasis — source faults (Q21/Q22)', () => {
  it('Q21 transient artifact-store failures retry technically with a restart-durable bounded backoff and zero model cost', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));

    const fault = new Error('SQLITE_BUSY: trajectory store unavailable');
    const first = await runPreflight(workspaceDir, { artifactStoreFault: fault });
    expect(first.decision).toBe('source_error');
    // Task stays wake-eligible — never mislabeled as an Owner fault.
    const afterFirst = await readTask(workspaceDir);
    expect(afterFirst?.status).toBe('pending');
    const piAfterFirst = afterFirst ? hydratePITaskRecord(afterFirst) : null;
    expect(piAfterFirst?.sourceFaultBackoff?.consecutiveFailures).toBe(1);
    expect(piAfterFirst?.sourceFaultBackoff?.skipCycles).toBe(1);

    // "Restart" (new handle) then a second fault: the counter survives and backs off one more cycle.
    const second = await runPreflight(workspaceDir, { artifactStoreFault: fault });
    expect(second.decision).toBe('source_error');
    const afterSecond = await readTask(workspaceDir);
    const piAfterSecond = afterSecond ? hydratePITaskRecord(afterSecond) : null;
    expect(piAfterSecond?.sourceFaultBackoff?.consecutiveFailures).toBe(2);
    expect(piAfterSecond?.sourceFaultBackoff?.skipCycles).toBe(2);

    // A later successful read clears the technical-fault state (material unchanged).
    const recovered = await runPreflight(workspaceDir);
    expect(recovered.decision).toBe('executable');
    const afterRecovery = await readTask(workspaceDir);
    const piAfterRecovery = afterRecovery ? hydratePITaskRecord(afterRecovery) : null;
    expect(piAfterRecovery?.sourceFaultBackoff).toBeUndefined();
  });

  it('Q22 the 3rd consecutive source fault ends auto-retry in a terminal review state labeled as a source fault, not an Owner fault', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));

    const fault = new Error('SQLITE_IOERR: disk image malformed');
    await runPreflight(workspaceDir, { artifactStoreFault: fault });
    await runPreflight(workspaceDir, { artifactStoreFault: fault });
    const third = await runPreflight(workspaceDir, { artifactStoreFault: fault });
    expect(third.decision).toBe('source_fault_persistent');

    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
    const piTask = task ? hydratePITaskRecord(task) : null;
    expect(piTask?.humanReviewContext?.reasonCode).toBe('source_fault_persistent');
    // The review context must NOT read as an Owner-labelling fault (SPEC §9).
    expect(piTask?.humanReviewContext?.reasonCode).not.toMatch(/owner_evidence|owner_behavior/);
    expect(piTask?.humanReviewContext?.detail).toContain('SQLITE_IOERR');
  });
});

describe('consumeSourceFaultBackoffSkip — cycle-entry backoff consumption (Q21)', () => {
  it('consumes one skip cycle per encounter and stops skipping at zero (restart-durable via state.db)', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));

    // Simulate one transient fault so the task carries a 1-cycle backoff.
    await runPreflight(workspaceDir, { artifactStoreFault: new Error('SQLITE_BUSY once') });
    const afterFault = await readTask(workspaceDir);
    const piAfterFault = afterFault ? hydratePITaskRecord(afterFault) : null;
    expect(piAfterFault?.sourceFaultBackoff).toMatchObject({ consecutiveFailures: 1, skipCycles: 1 });

    // First encounter after the fault: skip consumed (returns true) and the
    // stored skipCycles drops to zero — the next encounter no longer skips.
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    let firstEncounter: boolean;
    let secondEncounter: boolean;
    try {
      const { stateManager } = handle;
      const refreshed = hydratePITaskRecord(await stateManager.getTask(TASK_ID));
      if (!refreshed) throw new Error('task missing');
      firstEncounter = await consumeSourceFaultBackoffSkip(TASK_ID, refreshed, stateManager);
      const afterSkip = hydratePITaskRecord(await stateManager.getTask(TASK_ID));
      if (!afterSkip) throw new Error('task missing');
      expect(afterSkip.sourceFaultBackoff).toMatchObject({ consecutiveFailures: 1, skipCycles: 0 });
      secondEncounter = await consumeSourceFaultBackoffSkip(TASK_ID, afterSkip, stateManager);
    } finally {
      await handle.close().catch(() => undefined);
    }
    expect(firstEncounter).toBe(true);
    expect(secondEncounter).toBe(false);
  });
});

describe('preflightArtificerIntentBasis — idempotence (Q14)', () => {
  it('Q14 a repeated stop-point run never duplicates the review context and never loses the history', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, legacyScribeContent());

    await runPreflight(workspaceDir);
    const taskAfterFirst = await readTask(workspaceDir);
    const reviewAfterFirst = taskAfterFirst ? hydratePITaskRecord(taskAfterFirst)?.humanReviewContext : undefined;

    await runPreflight(workspaceDir);
    const taskAfterSecond = await readTask(workspaceDir);
    const piAfterSecond = taskAfterSecond ? hydratePITaskRecord(taskAfterSecond) : null;
    expect(piAfterSecond?.humanReviewContext?.reasonCode).toBe(reviewAfterFirst?.reasonCode);
    expect(piAfterSecond?.humanReviewContext?.createdAt).toBe(reviewAfterFirst?.createdAt);
    expect(piAfterSecond?.humanReviewContext?.sourceRunId).toBe(ARTIFICER_INTENT_NHR_SOURCE_RUN_ID);
  });
});
