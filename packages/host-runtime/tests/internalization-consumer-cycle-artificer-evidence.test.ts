/**
 * PRI-982 (SPEC-PD-IAER-001 FR-02 / FR-04 / §4.2 — T01, T02, T08) — consumer
 * cycle evidence preflight + authoritative channel routing.
 *
 * Drives the REAL `runInternalizationConsumerCycle` against a real workspace
 * (.pd/config.yaml + state.db). Only the LLM boundary is doubled
 * (ArtificerRunner.run — the spy also captures the runner's injected deps so
 * the assertions prove the production assembly). Contract pinned:
 *
 *   T01  code_tool_hook artificer + no Owner selection → task transitions to
 *        needs_human_review with the stable reasonCode, ArtificerRunner.run is
 *        NEVER invoked, ZERO new run rows, attemptCount untouched, no
 *        retry-wait transition, and the block evidence lands in the workspace
 *        critical-events sink (crash-durable Owner evidence);
 *   T02  the NHR task is outside the wake scan: 10 further cycles keep the
 *        state stable (no wake, no attempt, no repeated side effects);
 *   T08  code_tool_hook + valid selection + evidence port → L2 adapter with
 *        the assembled pack injected; prompt channel → non-L2 (PiAi) adapter
 *        with NO pack requirement; port ABSENT → observable
 *        evidence_source_unavailable degradation, task stays PENDING (SPEC
 *        §6.2: a host assembly gap is not "Owner has not labeled").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  ArtificerRunner,
  ArtificerL2Adapter,
  PiAiRuntimeAdapter,
  RuntimeStateManager,
  getDefaultPdConfig,
  type BehaviorExamplePack,
  type OwnerEvidenceSelection,
} from '@principles/core/runtime-v2';
import { runInternalizationConsumerCycle, type InternalizationConsumerCyclePorts } from '../src/internalization-consumer-cycle.js';

const dirs: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cycle-evidence-'));
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
  // JSON is valid YAML — same trick the sibling cycle tests use.
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}

const SCRIBE_TASK_ID = 'scribe-corr-001-code_tool_hook';
const ARTIFICER_TASK_ID = 'artificer-corr-001-code_tool_hook';
const PROMPT_SCRIBE_TASK_ID = 'scribe-corr-002-prompt';
const PROMPT_ARTIFICER_TASK_ID = 'artificer-corr-002-prompt';

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

function assemblingPort(pack: BehaviorExamplePack = VALID_PACK) {
  return {
    assemble: (): BehaviorExamplePack => pack,
  };
}

async function seedCodeChannelChain(workspaceDir: string, selection?: OwnerEvidenceSelection): Promise<void> {
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
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        // The successor id convention keys on correlationId — without it the
        // per-cycle succeeded-transition reconciliation would legitimately
        // create a SECOND artificer successor for the seeded scribe.
        correlationId: 'corr-001',
      }),
    });
    await stateManager.createTask({
      taskId: ARTIFICER_TASK_ID,
      taskKind: 'artificer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      resultRef: null,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        correlationId: 'corr-001',
        ...(selection !== undefined ? { ownerEvidenceSelection: selection } : {}),
      }),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function seedPromptChannelChain(workspaceDir: string): Promise<void> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    await stateManager.createTask({
      taskId: PROMPT_SCRIBE_TASK_ID,
      taskKind: 'scribe',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'scribe://seed',
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        correlationId: 'corr-002',
      }),
    });
    await stateManager.createTask({
      taskId: PROMPT_ARTIFICER_TASK_ID,
      taskKind: 'artificer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      resultRef: null,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [PROMPT_SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        correlationId: 'corr-002',
      }),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface CapturedRun {
  taskId: string;
  runtimeAdapter: unknown;
  behaviorExamplePack: BehaviorExamplePack | undefined;
}

/**
 * LLM boundary double: captures the runtime adapter + pack the cycle injected
 * into the REAL ArtificerRunner construction, then succeeds through the real
 * state manager (proves production assembly, not a mock).
 */
function spyArtificerRun(captured: CapturedRun[]): string[] {
  const runTaskIds: string[] = [];
  vi.spyOn(ArtificerRunner.prototype, 'run').mockImplementation(async function (this: ArtificerRunner, taskId: string) {
    runTaskIds.push(taskId);
    const self = this as unknown as { runtimeAdapter: unknown; behaviorExamplePack: BehaviorExamplePack | undefined; stateManager: RuntimeStateManager };
    captured.push({ taskId, runtimeAdapter: self.runtimeAdapter, behaviorExamplePack: self.behaviorExamplePack });
    await self.stateManager.markTaskSucceeded(taskId, 'artificer://test-run');
    return { status: 'succeeded' as const, taskId, attemptCount: 0 };
  });
  return runTaskIds;
}

function makePorts(overrides: Partial<InternalizationConsumerCyclePorts> = {}): InternalizationConsumerCyclePorts {
  return {
    owner: 'test-consumer',
    logLabel: 'EvidenceTest',
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    emitEvent: () => undefined,
    ...overrides,
  };
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

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

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

describe('runInternalizationConsumerCycle — PRI-982 evidence preflight + channel routing', () => {
  it('T01: code channel, no selection → NHR with reasonCode, runner never invoked, zero runs, no retry', async () => {
    const workspaceDir = makeWorkspace();
    await seedCodeChannelChain(workspaceDir, undefined);
    const captured: CapturedRun[] = [];
    const runTaskIds = spyArtificerRun(captured);
    const retryWaitSpy = vi.spyOn(RuntimeStateManager.prototype, 'markTaskRetryWait');

    const outcome = await runInternalizationConsumerCycle(workspaceDir, makePorts({
      behaviorEvidence: assemblingPort(),
    }));

    expect(outcome.ran).toBe(false);
    expect(outcome.skipReason).toBe('artificer_blocked_on_owner_evidence');
    // Preflight intercepted BEFORE any runner construction/run.
    expect(runTaskIds).toHaveLength(0);
    expect(captured).toHaveLength(0);
    // FR-02 acceptance: no retry, no attempt consumption, no run record.
    expect(retryWaitSpy).not.toHaveBeenCalled();
    expect(await countRunRows(workspaceDir, ARTIFICER_TASK_ID)).toBe(0);
    const { task, hydrated } = await readTask(workspaceDir, ARTIFICER_TASK_ID);
    expect(task?.status).toBe('needs_human_review');
    expect(task?.attemptCount).toBe(0);
    expect(hydrated?.humanReviewContext?.reasonCode).toBe('owner_behavior_examples_required');
    expect(hydrated?.humanReviewContext?.detail).toContain('pd runtime internalization retry --confirm');
    // Crash-durable Owner evidence in the workspace telemetry sink.
    const sink = fs.readFileSync(path.join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl'), 'utf-8');
    expect(sink).toContain('artificer_blocked_on_owner_evidence');
    expect(sink).toContain('owner_behavior_examples_required');
  });

  it('T02: NHR task is outside the wake scan — 10 further cycles leave it stable', async () => {
    const workspaceDir = makeWorkspace();
    await seedCodeChannelChain(workspaceDir, undefined);
    const captured: CapturedRun[] = [];
    spyArtificerRun(captured);

    const first = await runInternalizationConsumerCycle(workspaceDir, makePorts({ behaviorEvidence: assemblingPort() }));
    expect(first.skipReason).toBe('artificer_blocked_on_owner_evidence');

    for (let i = 0; i < 10; i += 1) {
      const outcome = await runInternalizationConsumerCycle(workspaceDir, makePorts({ behaviorEvidence: assemblingPort() }));
      expect(outcome.ran).toBe(false);
      expect(outcome.skipReason).toBe('no_ready_tasks');
    }

    const { task } = await readTask(workspaceDir, ARTIFICER_TASK_ID);
    expect(task?.status).toBe('needs_human_review');
    expect(task?.attemptCount).toBe(0);
    expect(captured).toHaveLength(0);
    expect(await countRunRows(workspaceDir, ARTIFICER_TASK_ID)).toBe(0);
  });

  it('T08a: code channel + valid selection + evidence port → L2 adapter with the assembled pack', async () => {
    const workspaceDir = makeWorkspace();
    await seedCodeChannelChain(workspaceDir, VALID_SELECTION);
    const captured: CapturedRun[] = [];
    const runTaskIds = spyArtificerRun(captured);

    const outcome = await runInternalizationConsumerCycle(workspaceDir, makePorts({
      behaviorEvidence: assemblingPort(),
    }));

    expect(outcome.ran).toBe(true);
    expect(outcome.runStatus).toBe('succeeded');
    expect(runTaskIds).toEqual([ARTIFICER_TASK_ID]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.runtimeAdapter).toBeInstanceOf(ArtificerL2Adapter);
    expect(captured[0]?.behaviorExamplePack).toEqual(VALID_PACK);
    const { task } = await readTask(workspaceDir, ARTIFICER_TASK_ID);
    expect(task?.status).toBe('succeeded');
  });

  it('T08b: prompt channel → non-L2 (PiAi) adapter, no pack requirement, task succeeds', async () => {
    const workspaceDir = makeWorkspace();
    await seedPromptChannelChain(workspaceDir);
    const captured: CapturedRun[] = [];
    const runTaskIds = spyArtificerRun(captured);

    const outcome = await runInternalizationConsumerCycle(workspaceDir, makePorts({
      // Even with a port present, prompt-channel tasks are evidence-exempt.
      behaviorEvidence: assemblingPort(),
    }));

    expect(outcome.ran).toBe(true);
    expect(outcome.runStatus).toBe('succeeded');
    expect(runTaskIds).toEqual([PROMPT_ARTIFICER_TASK_ID]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.runtimeAdapter).toBeInstanceOf(PiAiRuntimeAdapter);
    expect(captured[0]?.behaviorExamplePack).toBeUndefined();
  });

  it('port absent (host assembly gap) → evidence_source_unavailable, task stays pending, no runner', async () => {
    const workspaceDir = makeWorkspace();
    await seedCodeChannelChain(workspaceDir, undefined);
    const captured: CapturedRun[] = [];
    const runTaskIds = spyArtificerRun(captured);
    const events: Array<{ event: string; payload: string }> = [];

    const outcome = await runInternalizationConsumerCycle(workspaceDir, makePorts({
      emitEvent: (event, payload) => events.push({ event, payload }),
    }));

    expect(outcome.ran).toBe(false);
    expect(outcome.skipReason).toBe('evidence_source_unavailable');
    expect(runTaskIds).toHaveLength(0);
    // SPEC §6.2: an unavailable evidence source is NOT "Owner has not labeled"
    // — the task must stay pending, not enter needs_human_review.
    const { task } = await readTask(workspaceDir, ARTIFICER_TASK_ID);
    expect(task?.status).toBe('pending');
    // rc-9: the degradation is observable with a structured nextAction.
    const skip = events.find((e) => e.event === 'INTERNALIZATION_CONSUMER_SKIP');
    expect(skip).toBeDefined();
    const payload = JSON.parse(skip?.payload ?? '{}') as { reason?: string; nextAction?: string };
    expect(payload.reason).toBe('evidence_source_unavailable');
    expect(payload.nextAction).toContain('behaviorEvidence');
  });
});
