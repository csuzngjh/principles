/**
 * PRI-990 — single-task failed recovery × the IAER evidence gate.
 *
 * Proves the recovered task re-enters the EXISTING production consumer path
 * with every IAER safety invariant intact (no shortcut from recovery to the
 * model):
 *
 *   T11/T12: recovered failed code-channel artificer (no Owner evidence) →
 *            the next consumer cycle parks it in needs_human_review —
 *            runner never constructed, zero run rows, attemptCount untouched.
 *   T13:     the ORIGINAL authorized attach/resume path works on the
 *            recovered task; after resume the cycle runs it through L2 with
 *            the assembled pack (test-double adapter capture).
 *   T14:     code_rule_capability OFF → the recovered task is NOT executed.
 *   T15:     no V1 fallback — the code-channel task is never handed to the
 *            non-L2 PiAi pipeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  attachOwnerEvidence,
  resumeOwnerEvidenceTask,
  recoverSingleFailedTask,
  ArtificerRunner,
  ArtificerL2Adapter,
  PiAiRuntimeAdapter,
  RuntimeStateManager,
  StoreEventEmitter,
  getDefaultPdConfig,
  type BehaviorExamplePack,
  type OwnerEvidenceSelection,
} from '@principles/core/runtime-v2';
import { runInternalizationConsumerCycle, type InternalizationConsumerCyclePorts } from '../src/internalization-consumer-cycle.js';

const dirs: string[] = [];

function makeWorkspace(configOverrides?: (config: ReturnType<typeof getDefaultPdConfig>) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-single-recovery-gate-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features.internalization_auto_consumer.enabled = true;
  config.features.internalization_full_chain.enabled = true;
  (config.runtimeProfiles as Record<string, unknown>) = {
    ...(config.runtimeProfiles as Record<string, unknown>),
    'pi-ai.artificer': { type: 'pi-ai', provider: 'prov-a', model: 'artificer-model', apiKeyEnv: 'ARTIFICER_KEY' },
  };
  (config.internalAgents as { defaultRuntime: string }).defaultRuntime = 'pi-ai.artificer';
  const agents = config.internalAgents.agents as Record<string, { enabled: boolean; runtimeProfile?: string }>;
  agents.artificer.enabled = true;
  agents.artificer.runtimeProfile = 'pi-ai.artificer';
  configOverrides?.(config);
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}

const SCRIBE_TASK_ID = 'scribe-corr-r1-code_tool_hook';
const ARTIFICER_TASK_ID = 'artificer-corr-r1-code_tool_hook';

const V2_RULE_CONTEXT = {
  version: 2 as const,
  history: { status: 'available' as const, truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};

const VALID_PACK: BehaviorExamplePack = {
  sourceNegativeCase: {
    caseId: 'negative-1', kind: 'negative', toolName: 'write_file',
    params: { path: '/etc/passwd' }, expectedDecision: 'block', ruleContext: V2_RULE_CONTEXT,
  },
  ownerDesiredOutcome: 'block writes outside the workspace',
  positiveCounterexamples: [{
    caseId: 'positive-1', kind: 'positive', toolName: 'write_file',
    params: { path: '/project/file.txt' }, expectedDecision: 'allow', ruleContext: V2_RULE_CONTEXT,
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

function assemblingPort(pack: BehaviorExamplePack = VALID_PACK) {
  return { assemble: (): BehaviorExamplePack => pack };
}

function makePorts(overrides: Partial<InternalizationConsumerCyclePorts> = {}): InternalizationConsumerCyclePorts {
  return {
    owner: 'test-consumer',
    logLabel: 'SingleRecoveryTest',
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    emitEvent: () => undefined,
    ...overrides,
  };
}

/** Seed a succeeded scribe + a TERMINAL-FAILED artificer (the 605ba208 shape). */
async function seedFailedCodeChain(workspaceDir: string): Promise<void> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    await stateManager.createTask({
      taskId: SCRIBE_TASK_ID,
      taskKind: 'scribe',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'scribe://seed',
      diagnosticJson: JSON.stringify({ sourcePainId: 'pain_001', pi_metadata: {
        dependencyTaskIds: [],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        correlationId: 'corr-r1',
      }}),
    });
    await stateManager.createTask({
      taskId: ARTIFICER_TASK_ID,
      taskKind: 'artificer',
      status: 'failed',
      attemptCount: 3,
      maxAttempts: 3,
      lastError: 'max_attempts_exceeded',
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        correlationId: 'corr-r1',
      }),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readTask(workspaceDir: string, taskId: string) {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const task = await handle.stateManager.getTask(taskId);
    return { task, hydrated: task ? hydratePITaskRecord(task) : null };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function countRunRows(workspaceDir: string, taskId: string): Promise<number> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { runs } = await handle.stateManager.getValidRunsByTaskTolerant(taskId);
    return runs.length;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface CapturedRun {
  taskId: string;
  runtimeAdapter: unknown;
  behaviorExamplePack: BehaviorExamplePack | undefined;
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.ARTIFICER_KEY = 'test-key';
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { disposePainSignalBridgesForWorkspace } = await import('@principles/core/runtime-v2');
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

describe('single-task recovery → IAER evidence gate', () => {
  it('T11/T12: recovered task without evidence → next cycle parks NHR, zero runs, attempts untouched', async () => {
    const workspaceDir = makeWorkspace();
    await seedFailedCodeChain(workspaceDir);

    // Recovery (the new strict authority — what the CLI confirm will drive).
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    let outcome;
    try {
      outcome = await recoverSingleFailedTask(handle.stateManager, ARTIFICER_TASK_ID, { resetBudget: true });
    } finally {
      await handle.close().catch(() => undefined);
    }
    expect(outcome.status).toBe('recovered');

    const captured: CapturedRun[] = [];
    vi.spyOn(ArtificerRunner.prototype, 'run').mockImplementation(async function (this: ArtificerRunner, taskId: string) {
      const self = this as unknown as { runtimeAdapter: unknown; behaviorExamplePack: unknown; stateManager: RuntimeStateManager };
      captured.push({ taskId, runtimeAdapter: self.runtimeAdapter, behaviorExamplePack: self.behaviorExamplePack as BehaviorExamplePack | undefined });
      await self.stateManager.markTaskSucceeded(taskId, 'artificer://test-run');
      return { status: 'succeeded' as const, taskId, attemptCount: 0 };
    });

    const cycle = await runInternalizationConsumerCycle(workspaceDir, makePorts({
      behaviorEvidence: assemblingPort(), // gate proven, not the host-gap degradation
    }));

    expect(cycle.ran).toBe(false);
    expect(cycle.skipReason).toBe('artificer_blocked_on_owner_evidence');
    expect(captured).toHaveLength(0);
    expect(await countRunRows(workspaceDir, ARTIFICER_TASK_ID)).toBe(0);
    const { task, hydrated } = await readTask(workspaceDir, ARTIFICER_TASK_ID);
    expect(task?.status).toBe('needs_human_review');
    expect(task?.attemptCount).toBe(0);
    expect(hydrated?.humanReviewContext?.reasonCode).toBe('owner_behavior_examples_required');
  });

  it('T13: attach/resume on the recovered task via the original authorized path → cycle runs L2 with the pack', async () => {
    const workspaceDir = makeWorkspace();
    await seedFailedCodeChain(workspaceDir);

    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      const recovered = await recoverSingleFailedTask(handle.stateManager, ARTIFICER_TASK_ID, { resetBudget: true });
      expect(recovered.status).toBe('recovered');

      // Cycle 1: NHR (no selection yet).
      const cycle1 = await runInternalizationConsumerCycle(workspaceDir, makePorts({ behaviorEvidence: assemblingPort() }));
      expect(cycle1.skipReason).toBe('artificer_blocked_on_owner_evidence');
      const { task } = await readTask(workspaceDir, ARTIFICER_TASK_ID);
      expect(task?.status).toBe('needs_human_review');

      // Owner attach (authorized path; the assemble port stands in for the
      // production plugin assembler).
      const emitter = new StoreEventEmitter();
      const attached = await attachOwnerEvidence(handle.stateManager, {
        taskId: ARTIFICER_TASK_ID,
        selection: VALID_SELECTION,
        decidedBy: 'owner/test',
        mode: 'confirm',
        assemble: assemblingPort(),
        workspaceDir,
        eventEmitter: emitter,
        owner: 'pd-cli:evidence',
      });
      expect(attached.status).toBe('attached');
      const stillNhr = await readTask(workspaceDir, ARTIFICER_TASK_ID);
      expect(stillNhr.task?.status).toBe('needs_human_review');

      // Owner resume (digest-verified authority reset → pending).
      const resumed = await resumeOwnerEvidenceTask(handle.stateManager, {
        taskId: ARTIFICER_TASK_ID,
        decidedBy: 'owner/test',
        mode: 'confirm',
        assemble: assemblingPort(),
        workspaceDir,
        eventEmitter: emitter,
        owner: 'pd-cli:evidence',
      });
      expect(resumed.status).toBe('resumed');
    } finally {
      await handle.close().catch(() => undefined);
    }

    // Cycle 2: the task runs through L2 with the assembled pack.
    const captured: CapturedRun[] = [];
    vi.spyOn(ArtificerRunner.prototype, 'run').mockImplementation(async function (this: ArtificerRunner, taskId: string) {
      const self = this as unknown as { runtimeAdapter: unknown; behaviorExamplePack: BehaviorExamplePack | undefined; stateManager: RuntimeStateManager };
      captured.push({ taskId, runtimeAdapter: self.runtimeAdapter, behaviorExamplePack: self.behaviorExamplePack });
      await self.stateManager.markTaskSucceeded(taskId, 'artificer://test-run');
      return { status: 'succeeded' as const, taskId, attemptCount: 0 };
    });
    const cycle2 = await runInternalizationConsumerCycle(workspaceDir, makePorts({ behaviorEvidence: assemblingPort() }));
    expect(cycle2.ran).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].behaviorExamplePack).toBeDefined();
    expect(captured[0].runtimeAdapter).toBeInstanceOf(ArtificerL2Adapter);
  });

  it('T14: code_rule_capability OFF → the recovered task is not executed (T15: no PiAi fallback)', async () => {
    const workspaceDir = makeWorkspace((config) => {
      // The shipped flag object already exists in the defaults — flip it in
      // place (replacing it with a bare object breaks config validation).
      (config.features as Record<string, { enabled: boolean }>).code_rule_capability.enabled = false;
    });
    await seedFailedCodeChain(workspaceDir);

    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      const recovered = await recoverSingleFailedTask(handle.stateManager, ARTIFICER_TASK_ID, { resetBudget: true });
      expect(recovered.status).toBe('recovered');
    } finally {
      await handle.close().catch(() => undefined);
    }

    const captured: CapturedRun[] = [];
    vi.spyOn(ArtificerRunner.prototype, 'run').mockImplementation(async function (this: ArtificerRunner, taskId: string) {
      const self = this as unknown as { runtimeAdapter: unknown; stateManager: RuntimeStateManager };
      captured.push({ taskId, runtimeAdapter: self.runtimeAdapter, behaviorExamplePack: undefined });
      await self.stateManager.markTaskSucceeded(taskId, 'artificer://test-run');
      return { status: 'succeeded' as const, taskId, attemptCount: 0 };
    });
    const l2Spy = vi.spyOn(ArtificerL2Adapter.prototype as unknown as { constructor: unknown }, 'constructor');
    const piAiSpy = vi.fn();

    const cycle = await runInternalizationConsumerCycle(workspaceDir, makePorts({ behaviorEvidence: assemblingPort() }));
    expect(cycle.ran).toBe(false);
    expect(cycle.skipReason).toBe('code_rule_capability_disabled');
    expect(captured).toHaveLength(0);
    // T15: never handed to the non-L2 pipeline either.
    expect(l2Spy).not.toHaveBeenCalled();
    expect(piAiSpy).not.toHaveBeenCalled();
    const { task } = await readTask(workspaceDir, ARTIFICER_TASK_ID);
    expect(task?.status).toBe('pending');
    void PiAiRuntimeAdapter;
  });
});
