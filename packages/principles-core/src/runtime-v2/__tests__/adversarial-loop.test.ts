/**
 * runAdversarialLoop integration tests (RuleHost MVP, PRI-428).
 *
 * Exercises the synchronous Round 1→2 Artificer↔Evaluator loop (PRD Decision 11
 * multi-round). Real ArtificerRunner + EvaluatorRunner against a real
 * RuntimeStateManager + in-memory artifact store, with a controllable mock
 * runtimeAdapter whose fetchOutput returns scripted outputs per round.
 *
 * The tricky bit: EvaluatorRunner validates that the evaluator output's
 * sourceArtificerArtifactId matches the artificer artifact it resolved in
 * buildContext. The artificer's artifactId is `pi-art-<taskId>-<runId>`, which
 * the test cannot predict before the loop runs. So the scripted adapter uses
 * FACTORIES keyed by the artificer's startRun taskId: when the evaluator fetch
 * fires, the factory reads the last artificer's runId from the adapter's
 * recorded calls and produces a matching evaluator output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ArtificerRunner } from '../internalization/artificer-runner.js';
import { EvaluatorRunner } from '../internalization/evaluator-runner.js';
import { DefaultArtificerValidator } from '../internalization/artificer-output.js';
import { DefaultEvaluatorValidator } from '../internalization/evaluator-output.js';
import type { ArtificerOutputV1, ArtificerOutputV2 } from '../internalization/artificer-output.js';
import type { EvaluatorOutputV1, EvaluatorOutputV2 } from '../internalization/evaluator-output.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import { StoreEventEmitter } from '../store/event-emitter.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { PIArtifactRecord, PIArtifactStore } from '../internalization/pi-artifact.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { RefinerRuleHostGateDeps } from '../internalization/refiner-rulehost-gate.js';
import { runAdversarialLoop } from '../adversarial-loop.js';

/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/class-methods-use-this, @typescript-eslint/prefer-destructuring -- test double + guaranteed indexed lookups */
import { parsePITaskMetadata } from '../internalization/pitask-metadata.js';

const SCRIBE_TASK_ID = 'scribe-loop-001';

// ── Scripted adapter with per-round factories ────────────────────────────────

type ArtificerFactory = (taskId: string) => ArtificerOutputV1;
type EvaluatorFactory = (taskId: string, artificerArtifactId: string) => EvaluatorOutputV1;

class FactoryAdapter {
  private readonly artificerFactories: ArtificerFactory[] = [];
  private readonly evaluatorFactories: EvaluatorFactory[] = [];
  readonly startRunCalls: { taskId: string; inputPayload: unknown; runId: string }[] = [];
  /** Set by the harness so fetchOutput can resolve the REAL artificer artifactId. */
  artifactStore: PIArtifactStore | null = null;

  queueArtificer(factory: ArtificerFactory): void { this.artificerFactories.push(factory); }
  queueEvaluator(factory: EvaluatorFactory): void { this.evaluatorFactories.push(factory); }

  private async lastArtificerArtifactId(): Promise<string> {
    // Artificer runs are at even startRun indices (0, 2, 4...). The most
    // recent artificer call is the one preceding the current evaluator fetch.
    const artificerCalls = this.startRunCalls.filter((_, idx) => idx % 2 === 0);
    const last = artificerCalls[artificerCalls.length - 1];
    if (!last) throw new Error('no prior artificer run');
    // The artifactStore-assigned runId differs from the RunHandle runId, so we
    // read the REAL artifactId the ArtificerRunner wrote to the store.
    if (this.artifactStore) {
      const arts = await this.artifactStore.listBySourceTaskId(last.taskId);
      if (arts.length > 0 && arts[0]) return arts[0].artifactId;
    }
    return `pi-art-${last.taskId}-${last.runId}`;
  }

  async startRun(input: { taskRef: { taskId: string }; inputPayload: unknown }): Promise<RunHandle> {
    const runId = `run-${this.startRunCalls.length}`;
    this.startRunCalls.push({ taskId: input.taskRef.taskId, inputPayload: input.inputPayload, runId });
    return { runId: `run-${input.taskRef.taskId}`, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  }
  async pollRun(): Promise<RunStatus> { return { status: 'succeeded', runId: 'run-x' }; }
  async fetchOutput(): Promise<{ payload: unknown }> {
    const idx = this.startRunCalls.length - 1;
    if (idx % 2 === 0) {
      const factory = this.artificerFactories.shift();
      if (!factory) throw new Error('artificer factory queue empty');
      const call = this.startRunCalls[idx]!;
      return { payload: factory(call.taskId) };
    }
    const factory = this.evaluatorFactories.shift();
    if (!factory) throw new Error('evaluator factory queue empty');
    const call = this.startRunCalls[idx]!;
    return { payload: factory(call.taskId, await this.lastArtificerArtifactId()) };
  }
  async cancelRun(): Promise<void> { /* noop */ }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeScribeArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-scribe-loop-001',
    artifactKind: 'principle',
    sourceTaskId: SCRIBE_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: SCRIBE_TASK_ID,
      sourcePhilosopherArtifactId: 'pi-art-phil-loop',
      principleDraft: {
        title: 'Block system path writes',
        statement: 'Writes to /etc and other system directories must be blocked.',
      },
      sourceTrace: { philosopherArtifactId: 'pi-art-phil-loop' },
      risks: [],
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeArtificerV2(taskId: string): ArtificerOutputV2 {
  return {
    taskId,
    sourceScribeArtifactId: 'pi-art-scribe-loop-001',
    implementationPlan: {
      summary: 'Block system path writes',
      targetSurface: 'rule-host-evaluator',
      changes: ['Add path-prefix matcher'],
      tests: ['unit test for /etc prefix'],
      rolloutNotes: ['shadow mode'],
      confidence: 0.85,
    },
    implementationCode: 'function evaluate(input, helpers) { return { decision: "block", matched: true, reason: "system path" }; }',
    goldenTraceCases: [
      { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/project/file.txt' }, expectedDecision: 'allow' },
      { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
    ],
    affectedTools: ['write_file'],
    sourceTrace: { scribeArtifactId: 'pi-art-scribe-loop-001' },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

function makeArtificerV1(taskId: string): ArtificerOutputV1 {
  return {
    taskId,
    sourceScribeArtifactId: 'pi-art-scribe-loop-001',
    implementationPlan: {
      summary: 'Plan only, no code',
      targetSurface: 'docs',
      changes: ['document'],
      tests: [],
      rolloutNotes: [],
      confidence: 0.5,
    },
    sourceTrace: { scribeArtifactId: 'pi-art-scribe-loop-001' },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

function makeEvaluatorApproved(taskId: string, artificerArtifactId: string): EvaluatorOutputV2 {
  return {
    taskId,
    sourceArtificerArtifactId: artificerArtifactId,
    evaluation: { decision: 'approved', summary: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] },
    sourceTrace: { artificerArtifactId, scribeArtifactId: 'pi-art-scribe-loop-001' },
    risks: [],
    generatedAt: new Date().toISOString(),
    codeReview: {
      intentConsistency: { aligned: true, explanation: 'ok' },
      scopePrecision: { verdict: 'precise', explanation: 'ok' },
      traceCoverage: { sufficient: true, gaps: [], explanation: 'ok' },
    },
    adversarialCases: [
      { caseId: 'adv-1', attackType: 'boundary', toolName: 'write_file', params: { path: '/etc/x' }, expectedDecision: 'block', rationale: 'boundary' },
    ],
    adversarialResult: { passed: true, failedCases: [] },
  };
}

function makeEvaluatorNeedsRevision(taskId: string, artificerArtifactId: string): EvaluatorOutputV2 {
  return {
    taskId,
    sourceArtificerArtifactId: artificerArtifactId,
    evaluation: { decision: 'needs_revision', summary: 'revision needed', score: 0.4, strengths: [], concerns: ['code gap'], requiredChanges: ['fix matcher'] },
    sourceTrace: { artificerArtifactId, scribeArtifactId: 'pi-art-scribe-loop-001' },
    risks: [],
    generatedAt: new Date().toISOString(),
    codeReview: {
      intentConsistency: { aligned: true, explanation: 'ok' },
      scopePrecision: { verdict: 'precise', explanation: 'ok' },
      traceCoverage: { sufficient: true, gaps: [], explanation: 'ok' },
    },
    adversarialCases: [
      { caseId: 'adv-1', attackType: 'boundary', toolName: 'write_file', params: { path: '/etc/x' }, expectedDecision: 'block', rationale: 'boundary' },
    ],
    adversarialResult: {
      passed: false,
      failedCases: [
        { caseId: 'adv-1', attackType: 'boundary', actualDecision: 'allow', expectedDecision: 'block', rationale: 'code allowed /etc/x' },
      ],
    },
  };
}

function makePassingGateDeps(): RefinerRuleHostGateDeps {
  return {
    evaluateInSandbox: () => ({ success: true, failedCases: [], executionTimeMs: 1, forbiddenPatternViolations: [] }),
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

interface Harness {
  stateManager: RuntimeStateManager;
  artifactStore: MemoryPIArtifactStore;
  artificerRunner: ArtificerRunner;
  evaluatorRunner: EvaluatorRunner;
  adapter: FactoryAdapter;
  tmpDir: string;
}

async function makeHarness(opts: { gateDeps?: RefinerRuleHostGateDeps } = {}): Promise<Harness> {
  const tmpDir = path.join(os.tmpdir(), `pd-loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
  await stateManager.initialize();
  const artifactStore = new MemoryPIArtifactStore();
  const eventEmitter = new StoreEventEmitter();
  const adapter = new FactoryAdapter();
  adapter.artifactStore = artifactStore;

  const artificerRunner = new ArtificerRunner(
    { stateManager, runtimeAdapter: adapter as unknown as PDRuntimeAdapter, eventEmitter, validator: new DefaultArtificerValidator(), artifactStore },
    { owner: 'loop-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 1000 },
  );
  const evaluatorRunner = new EvaluatorRunner(
    { stateManager, runtimeAdapter: adapter as unknown as PDRuntimeAdapter, eventEmitter, validator: new DefaultEvaluatorValidator(), artifactStore },
    { owner: 'loop-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 1000, gateDeps: opts.gateDeps },
  );

  await stateManager.createTask({
    taskId: SCRIBE_TASK_ID,
    taskKind: 'scribe',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'scribe://x',
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 1000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-scribe-loop-001' }],
    }),
  });
  await artifactStore.upsertArtifact(makeScribeArtifact());

  return { stateManager, artifactStore, artificerRunner, evaluatorRunner, adapter, tmpDir };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runAdversarialLoop (PRI-428)', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness({ gateDeps: makePassingGateDeps() }); });
  afterEach(() => { try { fs.rmSync(h.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('Round 1 approved → 1 round, rule artifact written', async () => {
    h.adapter.queueArtificer(makeArtificerV2);
    h.adapter.queueEvaluator(makeEvaluatorApproved);

    const result = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    expect(result.decision).toBe('approved');
    expect(result.rounds).toBe(1);
    expect(result.ruleArtifactId).not.toBeNull();
  });

  it('Round 1 needs_revision + Round 2 approved → 2 rounds, rule artifact written', async () => {
    h.adapter.queueArtificer(makeArtificerV2);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    h.adapter.queueArtificer(makeArtificerV2);
    h.adapter.queueEvaluator(makeEvaluatorApproved);

    const result = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    expect(result.decision).toBe('approved');
    expect(result.rounds).toBe(2);
    expect(result.ruleArtifactId).not.toBeNull();
  });

  it('Round 1+2 both needs_revision → rejected (max rounds exhausted)', async () => {
    h.adapter.queueArtificer(makeArtificerV2);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    h.adapter.queueArtificer(makeArtificerV2);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);

    const result = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    expect(result.decision).toBe('rejected');
    expect(result.rounds).toBe(2);
    expect(result.degradationReason).toContain('round');
    // Principle artifact must remain for prompt-channel fallback.
    expect(result.principleArtifactId).not.toBeNull();
    expect(result.ruleArtifactId).toBeNull();
  });

  it('Artificer L2 degraded to V1 → rejected, skip code review', async () => {
    h.adapter.queueArtificer(makeArtificerV1);
    // Evaluator still runs (V1 path) but should not write a rule artifact.
    h.adapter.queueEvaluator((taskId, artificerArtifactId) => ({
      taskId,
      sourceArtificerArtifactId: artificerArtifactId,
      evaluation: { decision: 'approved', summary: 'v1 plan approved', score: 0.7, strengths: [], concerns: [], requiredChanges: [] },
      sourceTrace: { artificerArtifactId, scribeArtifactId: 'pi-art-scribe-loop-001' },
      risks: [],
      generatedAt: new Date().toISOString(),
    }));

    const result = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    expect(result.decision).toBe('rejected');
    expect(result.degradationReason).toContain('v1');
    expect(result.ruleArtifactId).toBeNull();
  });

  it('adversarialFeedback from Round 1 is injected into Round 2 Artificer prompt', async () => {
    h.adapter.queueArtificer(makeArtificerV2);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    h.adapter.queueArtificer(makeArtificerV2);
    h.adapter.queueEvaluator(makeEvaluatorApproved);

    await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    // startRunCalls: [artificer-r1, evaluator-r1, artificer-r2, evaluator-r2]
    // Round-2 artificer is index 2.
    const round2ArtificerCall = h.adapter.startRunCalls[2];
    const round2Payload = round2ArtificerCall!.inputPayload;
    expect(round2ArtificerCall).toBeDefined();
    const promptStr = typeof round2ArtificerCall!.inputPayload === 'string'
      ? round2ArtificerCall!.inputPayload
      : JSON.stringify(round2ArtificerCall!.inputPayload);
    // The feedback must reference the Round-1 failed case.
    expect(promptStr).toContain('adv-1');
    // Round-1 artificer (index 0) must NOT carry the structured feedback
    // field. (The protocol instruction text always mentions `adversarialFeedback`
    // by name; check the parsed JSON field, not the raw substring.)
    const round1ArtificerCall = h.adapter.startRunCalls[0];
    const round1Payload = round1ArtificerCall!.inputPayload;
    const round1Parsed: Record<string, unknown> = typeof round1Payload === 'string'
      ? JSON.parse(round1Payload) as Record<string, unknown>
      : round1Payload as Record<string, unknown>;
    expect(Object.hasOwn(round1Parsed, 'adversarialFeedback')).toBe(false);
    // Round-2 artificer MUST carry the structured field.
    const round2Parsed: Record<string, unknown> = typeof round2Payload === 'string'
      ? JSON.parse(round2Payload) as Record<string, unknown>
      : round2Payload as Record<string, unknown>;
    expect(Object.hasOwn(round2Parsed, 'adversarialFeedback')).toBe(true);
  });

  it('adversarialFeedback is stored on the Round-2 artificer task diagnosticJson', async () => {
    h.adapter.queueArtificer(makeArtificerV2);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    h.adapter.queueArtificer(makeArtificerV2);
    h.adapter.queueEvaluator(makeEvaluatorApproved);

    await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    // The Round-2 artificer task is the 2nd artificer task created. Find it
    // by scanning tasks for kind=artificer and reading its diagnosticJson.
    const allTasks = await h.stateManager.listTasks();
    const artificerTasks = allTasks.filter((t) => t.taskKind === 'artificer');
    expect(artificerTasks.length).toBe(2);
    const round2Task = artificerTasks[1]!;
    const diagJson = typeof round2Task.diagnosticJson === 'string' ? round2Task.diagnosticJson : '';
    const meta = parsePITaskMetadata(diagJson);
    expect(meta?.adversarialFeedback).toBeDefined();
    expect(typeof meta?.adversarialFeedback).toBe('string');
    expect(meta!.adversarialFeedback!.length).toBeGreaterThan(0);
  });
  it('P1 regression: V1 degradation path does not throw when evaluator task creation fails (ERR-018 never-throws)', async () => {
    h.adapter.queueArtificer(makeArtificerV1);

    // Wrap the stateManager so createTask throws ONLY for the V1 evaluator
    // task (taskKind='evaluator'). This exercises the previously-unguarded
    // createEvaluatorTask call in the V1 branch. The loop must catch it and
    // return { decision: 'rejected' } rather than throwing.
    const realCreate = h.stateManager.createTask.bind(h.stateManager);
    const throwingSm = {
      ...h.stateManager,
      createTask: async (record: Parameters<typeof realCreate>[0]) => {
        if (record.taskKind === 'evaluator') {
          throw new Error('simulated V1 evaluator task create failure');
        }
        return realCreate(record);
      },
    } as unknown as typeof h.stateManager;

    // Must NOT throw — resolve to rejected.
    const result = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: throwingSm,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    expect(result.decision).toBe('rejected');
    expect(result.degradationReason).toContain('v1');
    expect(result.ruleArtifactId).toBeNull();
  });
});
