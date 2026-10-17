/**
 * SPEC-RULECODE-QUALITY-001 A1 — consumer-cycle wiring of the artificer
 * intent-basis preflight (Q01 / Q20 wiring level).
 *
 * Drives the REAL `runInternalizationConsumerCycle` against a real workspace.
 * Only the LLM boundary is doubled (ArtificerRunner.run spy — which also
 * proves the runner was/was-not constructed):
 *
 *   T-I1  code_tool_hook artificer + valid Owner evidence + LEGACY scribe
 *         artifact (no executionConditions — the original pain's chain shape)
 *         → needs_human_review intent_unverified, runner NEVER invoked, zero
 *         new run rows (Q01);
 *   T-I2  scribe artifact with executionConditions.requiredFacts=[] → the
 *         runner IS constructed and runs, and the versioned
 *         intentBasisVerification record lands in the task metadata;
 *   T-I3  a required design-approval fact + no trusted-facts port →
 *         needs_human_review trusted_fact_provider_absent, runner never
 *         invoked (host capability gap ≠ transient error);
 *   T-I4  Q20 bypass control: invoking the ArtificerRunner directly (run-once
 *         CLI shape) with a legacy scribe artifact fails LOUD before any LLM
 *         call — the entry preflight cannot be skipped by route choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyTrajectorySchemaBase,
  buildToolSemanticRegistry,
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  ArtificerRunner,
  PDRuntimeError,
  getDefaultPdConfig,
  type BehaviorExamplePack,
  type OwnerEvidenceSelection,
} from '@principles/core/runtime-v2';
import { runInternalizationConsumerCycle, type InternalizationConsumerCyclePorts } from '../src/internalization-consumer-cycle.js';

const dirs: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cycle-intent-'));
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
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}

const SCRIBE_TASK_ID = 'scribe-intent-corr-001';
const ARTIFICER_TASK_ID = 'artificer-intent-corr-001';

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

const INTENT_CONTRACT = {
  ownerIntent: 'complex changes must not be implemented before the design is confirmed by the Owner',
  targetBehavior: 'agent pauses complex edits and requests design confirmation first',
  forbiddenBehavior: 'implementing complex changes without a confirmed design',
  evidenceSource: 'pain:pain_001',
  validationExpectation: 'rule blocks complex-change writes that carry no confirmed-design evidence',
};

function scribeContent(
  executionConditions?: { version: 1; requiredFacts: Array<{ factKind: string; required: boolean; textualBasis: string }> },
  opts: { approval?: boolean } = {},
): string {
  // default = the approval-gated original-pain material; opts.approval=false
  // yields a non-approval principle whose empty requiredFacts are
  // self-consistent (the T-I2 executable case).
  const approval = opts.approval !== false;
  const intentContract = approval
    ? INTENT_CONTRACT
    : {
        ownerIntent: 'files must be read before they are written',
        targetBehavior: 'every write to a file is preceded by a read of that file in the same session',
        forbiddenBehavior: 'writing a file that was not read earlier in the session',
        evidenceSource: 'pain:pain_001',
        validationExpectation: 'rule blocks writes whose context facts show no prior read of the target',
      };
  const statement = approval
    ? 'Complex changes require confirmed design before implementation'
    : 'Files must be read before they are written';
  return JSON.stringify({
    taskId: SCRIBE_TASK_ID,
    sourcePhilosopherArtifactId: 'art-phil-001',
    principleDraft: {
      title: approval ? 'Design confirmation before complex changes' : 'Read before write',
      statement,
      rationale: approval ? 'unconfirmed complex edits caused the original pain' : 'blind edits caused the original pain',
      applicability: approval ? ['complex code changes'] : ['write_file calls'],
      antiPatterns: approval ? ['implementing complex changes without design confirmation'] : ['writing a file that was never read'],
      confidence: 0.9,
    },
    sourceTrace: { philosopherArtifactId: 'art-phil-001' },
    risks: [],
    intentContract,
    ...(executionConditions !== undefined ? { executionConditions } : {}),
    generatedAt: '2026-10-16T00:00:00.000Z',
  });
}

async function seedChain(workspaceDir: string, scribeContentJson: string): Promise<void> {
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
        correlationId: 'corr-intent-001',
      }}),
    });
    const now = new Date().toISOString();
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId: `pi-art-${SCRIBE_TASK_ID}-run-1`,
      artifactKind: 'principle',
      sourceTaskId: SCRIBE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: scribeContentJson,
      createdAt: now,
      updatedAt: now,
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
        correlationId: 'corr-intent-001',
        ownerEvidenceSelection: VALID_SELECTION,
      }),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

let runTaskIds: string[] = [];

let capturedTrustedFacts: unknown = 'not-constructed';

function spyArtificerRun(): void {
  runTaskIds = [];
  capturedTrustedFacts = 'not-constructed';
  vi.spyOn(ArtificerRunner.prototype, 'run').mockImplementation(async function (this: ArtificerRunner, taskId: string) {
    runTaskIds.push(taskId);
    const self = this as unknown as {
      stateManager: { markTaskSucceeded: (id: string, ref: string) => Promise<unknown> };
      trustedFacts?: unknown;
    };
    capturedTrustedFacts = self.trustedFacts === undefined ? undefined : self.trustedFacts;
    await self.stateManager.markTaskSucceeded(taskId, 'artificer://test-run');
    return { status: 'succeeded' as const, taskId, attemptCount: 0 };
  });
}

function makePorts(): InternalizationConsumerCyclePorts {
  return {
    owner: 'test-consumer',
    logLabel: 'IntentTest',
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    emitEvent: () => undefined,
    behaviorEvidence: { assemble: () => VALID_PACK },
  };
}

async function readArtificerTask(workspaceDir: string) {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const task = await handle.stateManager.getTask(ARTIFICER_TASK_ID);
    return { task, hydrated: task ? hydratePITaskRecord(task) : null };
  } finally {
    await handle.close().catch(() => undefined);
  }
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
      } catch (err) {
        lastError = err;
        await sleep(50);
      }
    }
    if (lastError !== null) throw lastError;
  }
});

describe('consumer cycle — artificer intent-basis preflight wiring', () => {
  it('T-I1 (Q01): legacy scribe artifact stops the artificer at needs_human_review with zero generation', async () => {
    const workspaceDir = makeWorkspace();
    await seedChain(workspaceDir, scribeContent()); // legacy — no executionConditions
    spyArtificerRun();

    const outcome = await runInternalizationConsumerCycle(workspaceDir, makePorts());
    expect(outcome.ran).toBe(false);

    expect(runTaskIds).toEqual([]); // ZERO generation calls
    const { task, hydrated } = await readArtificerTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
    expect(hydrated?.humanReviewContext?.reasonCode).toBe('execution_conditions_missing');
  });

  it('T-I2: complete intent basis lets the runner run and records the versioned verification', async () => {
    const workspaceDir = makeWorkspace();
    // Self-consistent executable: a principle enforceable from observable
    // input, whose intent material carries NO approval semantics, declaring
    // requiredFacts: [] (Owner review P1: an approval-shaped material with []
    // is the under-reporting attack and stops — see the core audit tests).
    await seedChain(workspaceDir, scribeContent({ version: 1, requiredFacts: [] }, { approval: false }));
    spyArtificerRun();

    const outcome = await runInternalizationConsumerCycle(workspaceDir, makePorts());
    expect(outcome.ran).toBe(true);
    expect(runTaskIds).toEqual([ARTIFICER_TASK_ID]);

    const { hydrated } = await readArtificerTask(workspaceDir);
    expect(hydrated?.intentBasisVerification?.version).toBe(1);
    expect(hydrated?.intentBasisVerification?.result).toBe('executable');
    expect(hydrated?.intentBasisVerification?.scribeArtifactDigest).toMatch(/^sha256:/);
  });

  it('T-I3: a required design-approval fact with no trusted-facts port stops as a host capability gap', async () => {
    const workspaceDir = makeWorkspace();
    await seedChain(workspaceDir, scribeContent({
      version: 1,
      requiredFacts: [{ factKind: 'design_approval', required: true, textualBasis: 'complex changes require confirmed design before implementation' }],
    }));
    spyArtificerRun();

    const outcome = await runInternalizationConsumerCycle(workspaceDir, makePorts());
    expect(outcome.ran).toBe(false);
    expect(runTaskIds).toEqual([]);
    const { task, hydrated } = await readArtificerTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
    expect(hydrated?.humanReviewContext?.reasonCode).toBe('trusted_fact_provider_absent');
  });

  it('T-I5 (Owner review P2): the trusted-facts port rides from ports into BOTH the preflight and the runner', async () => {
    const workspaceDir = makeWorkspace();
    // Approval-gated principle WITH a declared required fact; the port
    // resolves it — the entry gate must pass AND the runner must be
    // constructed carrying the SAME port (defensive mirror agreement).
    await seedChain(workspaceDir, scribeContent({
      version: 1,
      requiredFacts: [{ factKind: 'design_approval', required: true, textualBasis: 'complex changes require confirmed design before implementation' }],
    }, { approval: true }));
    const resolvedPort = {
      resolveRequiredFact: () => ({ resolution: 'approved' as const, detail: 'host decision record' }),
    };
    spyArtificerRun();

    const outcome = await runInternalizationConsumerCycle(workspaceDir, {
      ...makePorts(),
      trustedFacts: resolvedPort,
    });
    expect(outcome.ran).toBe(true);
    expect(runTaskIds).toEqual([ARTIFICER_TASK_ID]);
    expect(capturedTrustedFacts).toBe(resolvedPort); // SAME port instance reached the runner
  });

  it('T-I4 (Q20): the runner itself refuses a legacy scribe artifact before any LLM call (bypass control)', async () => {
    const workspaceDir = makeWorkspace();
    await seedChain(workspaceDir, scribeContent());

    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      const { stateManager } = handle;
      let startRunCalls = 0;
      const refusingAdapter = {
        startRun: async () => { startRunCalls += 1; return { runId: 'run-should-never-start' }; },
        fetchOutput: async () => { throw new Error('unreachable'); },
        cancelRun: async () => undefined,
      };
      const runner = new ArtificerRunner(
        {
          stateManager,
          runtimeAdapter: refusingAdapter as never,
          eventEmitter: { emitTelemetry: () => true as const } as never,
          artifactStore: stateManager.piArtifactStore,
          validator: { validate: async () => ({ valid: true, errors: [] }) } as never,
          behaviorExamplePack: VALID_PACK,
        },
        { owner: 'test', runtimeKind: 'pi-ai', timeoutMs: 5_000 },
      );
      const context = await runner.buildContext(ARTIFICER_TASK_ID);
      await expect(runner.invokeRuntime(ARTIFICER_TASK_ID, context)).rejects.toMatchObject({
        category: 'input_invalid',
        message: expect.stringContaining('intent_basis_unverified'),
      });
      expect(startRunCalls).toBe(0); // no LLM call was ever started
    } finally {
      await handle.close().catch(() => undefined);
    }
  });
});
