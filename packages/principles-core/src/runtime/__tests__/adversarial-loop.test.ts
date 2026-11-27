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
import type { ArtificerRuleOutput } from '../internalization/artificer-output.js';
import type { BehaviorExamplePack } from '../internalization/behavior-example-pack.js';
import type { EvaluatorOutputV1, EvaluatorOutputV2 } from '../internalization/evaluator-output.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { StoreEventEmitter } from '../store/event-emitter.js';
import { createPITaskDiagnosticJson, artificerRepairTaskId, hydratePITaskRecord } from '../internalization/pitask-metadata.js';
import { InternalizationOrchestrator } from '../internalization/internalization-orchestrator.js';
import type { PIArtifactRecord, PIArtifactStore } from '../internalization/pi-artifact.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { RefinerRuleHostGateDeps } from '../internalization/refiner-rulehost-gate.js';
import { runAdversarialLoop } from '../adversarial-loop.js';
import { createLogicalSuccessorTask } from '../internalization/successor-create.js';
import { reopenTaskForRevision } from '../internalization/revision-reopen.js';
import type { RetryPolicyConfig } from '../store/lifecycle/retry-policy.js';

/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/class-methods-use-this, @typescript-eslint/prefer-destructuring -- test double + guaranteed indexed lookups */
import { parsePITaskMetadata } from '../internalization/pitask-metadata.js';

const SCRIBE_TASK_ID = 'scribe-loop-001';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected record fixture');
  }
  return value;
}

// ── Scripted adapter with per-round factories ────────────────────────────────

type ArtificerFactory = (taskId: string) => ArtificerRuleOutput;
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

// PRI-780: v2-only generation — the loop harness carries a valid pack and
// v2-aligned outputs (case parity incl. ruleContext is machine-checked).
const LOOP_RULE_CONTEXT = {
  version: 2 as const,
  history: { status: 'available' as const, truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};
const LOOP_TEST_PACK: BehaviorExamplePack = {
  sourceNegativeCase: {
    caseId: 'neg-1', kind: 'negative', toolName: 'write_file',
    params: { path: '/etc/passwd' }, expectedDecision: 'block',
    ruleContext: LOOP_RULE_CONTEXT,
  },
  ownerDesiredOutcome: 'block system-path writes',
  positiveCounterexamples: [{
    caseId: 'pos-1', kind: 'positive', toolName: 'write_file',
    params: { path: '/project/file.txt' }, expectedDecision: 'allow',
    ruleContext: LOOP_RULE_CONTEXT,
  }],
  evidenceRefs: ['pain://loop-1'],
  redactionNotes: [],
};

function makeArtificerOutput(taskId: string): ArtificerRuleOutput {
  return {
    taskId,
    sourceScribeArtifactId: 'pi-art-scribe-loop-001',
    requiresContextVersion: 2,
    evidenceRefs: ['pain://loop-1'],
    implementationCode: 'function evaluate(input, helpers) { return { decision: "block", matched: true, reason: "system path" }; }',
    goldenTraceCases: [
      { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/project/file.txt' }, expectedDecision: 'allow', ruleContext: LOOP_RULE_CONTEXT },
      { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block', ruleContext: LOOP_RULE_CONTEXT },
    ],
    affectedTools: ['write_file'],
    implementationSummary: 'Block system path writes',
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

function makeFailingGateDeps(): RefinerRuleHostGateDeps {
  return {
    evaluateInSandbox: () => ({
      success: false,
      failedCases: [{ caseId: 'neg-1', errorType: 'runtime_error', message: 'sandbox blocked /etc/x' }],
      executionTimeMs: 1,
      forbiddenPatternViolations: [],
    }),
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

interface Harness {
  stateManager: RuntimeStateManager;
  artifactStore: PIArtifactStore;
  artificerRunner: ArtificerRunner;
  evaluatorRunner: EvaluatorRunner;
  adapter: FactoryAdapter;
  tmpDir: string;
}

async function makeHarness(opts: { gateDeps?: RefinerRuleHostGateDeps; retryPolicyConfig?: RetryPolicyConfig } = {}): Promise<Harness> {
  const tmpDir = path.join(os.tmpdir(), `pd-loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const stateManager = new RuntimeStateManager({
    workspaceDir: tmpDir,
    ...(opts.retryPolicyConfig !== undefined ? { retryPolicyConfig: opts.retryPolicyConfig } : {}),
  });
  await stateManager.initialize();
  const artifactStore = stateManager.piArtifactStore;
  const eventEmitter = new StoreEventEmitter();
  const adapter = new FactoryAdapter();
  adapter.artifactStore = artifactStore;

  const artificerRunner = new ArtificerRunner(
    { stateManager, runtimeAdapter: adapter as unknown as PDRuntimeAdapter, eventEmitter, validator: new DefaultArtificerValidator(), artifactStore, behaviorExamplePack: LOOP_TEST_PACK },
    { owner: 'loop-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 1000 },
  );
  const evaluatorRunner = new EvaluatorRunner(
    { stateManager, runtimeAdapter: adapter as unknown as PDRuntimeAdapter, eventEmitter, validator: new DefaultEvaluatorValidator(), artifactStore },
    { owner: 'loop-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 1000, gateDeps: opts.gateDeps },
  );

  await stateManager.createTask({
    taskId: 'dreamer-loop-root',
    taskKind: 'dreamer',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'dreamer://x',
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      correlationId: 'candidate-loop-001',
      timeoutMs: 1000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  });
  await stateManager.createTask({
    taskId: SCRIBE_TASK_ID,
    taskKind: 'scribe',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'scribe://x',
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: ['dreamer-loop-root'],
      channel: 'prompt',
      correlationId: 'candidate-loop-001',
      timeoutMs: 1000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-scribe-loop-001' }],
      parentTaskId: 'dreamer-loop-root',
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
    h.adapter.queueArtificer(makeArtificerOutput);
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

  it('does not report approved when the evaluator produced no rule artifact', async () => {
    // PRI-634 A2 (authority migration): the fixture Artificer output is
    // code-bearing (implementationCode + goldenTraceCases), so the
    // deterministic gate now RUNS for approved verdicts regardless of the
    // evaluator's V1/V2 output shape. To keep this test's original contract
    // — approved without a durable rule artifact must degrade to rejected —
    // we fail the gate instead: adversarialResult.passed=false → rule
    // assembly is skipped → no rule artifact → rejected.
    try { fs.rmSync(h.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    h = await makeHarness({ gateDeps: makeFailingGateDeps() });
    // EP002-R4: approved + failed adversarial replay is now needs_revision
    // (PRI-758 semantics) — the loop feeds the failed cases into a second
    // round instead of rejecting with 'evaluator_approved_without_rule_
    // artifact'. Queue TWO artificer rounds so the loop exhausts its rounds
    // against the persistently failing gate; the contract under test — never
    // report approved without a durable rule artifact — is unchanged.
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator((taskId, artificerArtifactId) => ({
      taskId,
      sourceArtificerArtifactId: artificerArtifactId,
      evaluation: { decision: 'approved', summary: 'plan only', score: 0.9, strengths: [], concerns: [], requiredChanges: [] },
      sourceTrace: { artificerArtifactId },
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
    expect(result.ruleArtifactId).toBeNull();
    expect(result.degradationReason).toBeTruthy();
  });

  it('enforces the two-round hard cap when callers request more rounds', async () => {
    for (let i = 0; i < 3; i += 1) {
      h.adapter.queueArtificer(makeArtificerOutput);
      h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    }

    const result = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
      maxRounds: 3,
    });

    expect(result.rounds).toBe(2);
    expect(h.adapter.startRunCalls).toHaveLength(4);
  });

  it('Round 1 needs_revision + Round 2 approved → 2 rounds, rule artifact written', async () => {
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    h.adapter.queueArtificer(makeArtificerOutput);
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
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    h.adapter.queueArtificer(makeArtificerOutput);
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

  it('adversarialFeedback from Round 1 is injected into Round 2 Artificer prompt', async () => {
    // PRI-634 R4: 用 makeFailingGateDeps 确保 Round-1 的诊断重放真实产生
    // failedCases，验证对抗反馈传递链仍工作（反馈来源=真实 gate 结果，非 LLM 声明）。
    // 旧行为（needs_revision → skip replay）下 feedback 依赖 LLM 声明的
    // adversarialResult；R4 后真实 gate 执行，feedback 以 gate 观察为准。
    const oldH = h;
    h = await makeHarness({ gateDeps: makeFailingGateDeps() });
    await oldH.stateManager.close();
    try { fs.rmSync(oldH.tmpDir, { recursive: true, force: true }); } catch { /* temp */ }
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    h.adapter.queueArtificer(makeArtificerOutput);
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
    // The feedback must reference the Round-1 failed case (from the real gate).
    // makeFailingGateDeps 的 failedCases 中 caseId 为 'neg-1'。
    expect(promptStr).toContain('neg-1');
    // Legacy shape: this gate failure carries no caseInput — the prompt must
    // not render an empty caseInput continuation line.
    expect(promptStr).not.toContain('caseInput:');
    // Round-1 artificer (index 0) must NOT carry the structured feedback
    // field. (The protocol instruction text always mentions `adversarialFeedback`
    // by name; check the parsed JSON field, not the raw substring.)
    const round1ArtificerCall = h.adapter.startRunCalls[0];
    const round1Payload = round1ArtificerCall!.inputPayload;
    const round1Parsed = requireRecord(typeof round1Payload === 'string'
      ? JSON.parse(round1Payload)
      : round1Payload);
    expect(Object.hasOwn(round1Parsed, 'adversarialFeedback')).toBe(false);
    // Round-2 artificer MUST carry the structured field.
    const round2Parsed = requireRecord(typeof round2Payload === 'string'
      ? JSON.parse(round2Payload)
      : round2Payload);
    expect(Object.hasOwn(round2Parsed, 'adversarialFeedback')).toBe(true);
  });

  it('P2-1 fidelity: the failed case caseInput (target + facts) reaches the Round-2 Artificer prompt', async () => {
    // Full production chain under test: real gate replay → mapFailedCases
    // (caseInput from the matched adversarial case) → evaluator artifact →
    // formatAdversarialFeedback → Round-2 diagnosticJson → Artificer prompt.
    // The gate fails the LLM-declared case 'adv-1' as an expected/actual
    // MISMATCH (the shape that carries actionable caseInput in real chains).
    const mismatchGateDeps: RefinerRuleHostGateDeps = {
      evaluateInSandbox: () => ({
        success: false,
        failedCases: [{
          caseId: 'adv-1', errorType: 'validation_failed',
          message: 'Expected block but got allow',
          expectedDecision: 'block', actualDecision: 'allow',
        }],
        executionTimeMs: 1,
        forbiddenPatternViolations: [],
      }),
    };
    const oldH = h;
    h = await makeHarness({ gateDeps: mismatchGateDeps });
    await oldH.stateManager.close();
    try { fs.rmSync(oldH.tmpDir, { recursive: true, force: true }); } catch { /* temp */ }
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorApproved);

    await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    // Final Round-2 payload (the LLM boundary spy sees exactly what the model
    // receives; the prompt builder injects the adversarialFeedback field into
    // the model-visible payload verbatim): the failed case's tool, target
    // path and context facts must be visible, not just the verdict line.
    const round2ArtificerCall = h.adapter.startRunCalls[2];
    expect(round2ArtificerCall).toBeDefined();
    const round2Payload = round2ArtificerCall!.inputPayload;
    const round2Parsed = requireRecord(typeof round2Payload === 'string'
      ? JSON.parse(round2Payload)
      : round2Payload);
    const feedbackText = typeof round2Parsed.adversarialFeedback === 'string' ? round2Parsed.adversarialFeedback : '';
    expect(feedbackText).toContain('caseInput:');
    expect(feedbackText).toContain('tool=write_file');
    expect(feedbackText).toContain('target="/etc/x"');
    expect(feedbackText).toContain('priorReadOfTarget=');
    // Lineage: the same feedback text stored on the Round-2 task diagnosticJson
    // is what the payload carried — one source, no divergence.
    const allTasks = await h.stateManager.listTasks();
    const artificerTasks = allTasks.filter((t) => t.taskKind === 'artificer');
    const round2Task = artificerTasks[1]!;
    const diagJson = typeof round2Task.diagnosticJson === 'string' ? round2Task.diagnosticJson : '';
    const meta = parsePITaskMetadata(diagJson);
    expect(meta?.adversarialFeedback).toContain('caseInput:');
    expect(meta!.adversarialFeedback).toContain('target="/etc/x"');
    // Full-equality lineage (r6 hardening, 2026-10-12): substring checks above
    // prove presence in both carriers but not identity between them. The
    // payload must carry the stored feedback text VERBATIM — one string, zero
    // divergence — so the repair prompt can never drift from the durable
    // diagnosticJson record.
    expect(typeof round2Parsed.adversarialFeedback).toBe('string');
    expect(feedbackText).toBe(meta!.adversarialFeedback);
  });

  it('adversarialFeedback is stored on the Round-2 artificer task diagnosticJson', async () => {
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    h.adapter.queueArtificer(makeArtificerOutput);
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
  it('artificer failure (throw) → rejected with artificer_run_threw, no rule artifact (ERR-018 never-throws)', async () => {
    // PRI-439: the V1 degradation path is gone. Artificer exhaustion now throws
    // PDRuntimeError('output_invalid', ...) (see ArtificerL2Adapter). The loop
    // must catch the throw and return { decision: 'rejected' } with
    // degradationReason 'artificer_run_threw: ...' rather than propagating.
    const throwingRunner = {
      ...h.artificerRunner,
      run: async () => { throw new Error('simulated artificer exhaustion'); },
    } as unknown as typeof h.artificerRunner;

    const result = await runAdversarialLoop({
      artificerRunner: throwingRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    expect(result.decision).toBe('rejected');
    expect(result.degradationReason).toContain('artificer_run_threw');
    expect(result.ruleArtifactId).toBeNull();
  });

  it('recovers succeeded artificer and evaluator results on rerun without another runtime execution', async () => {
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorApproved);
    const input = {
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    };

    const first = await runAdversarialLoop(input);
    expect(first.decision).toBe('approved');
    const executionsAfterFirst = h.adapter.startRunCalls.length;
    expect(executionsAfterFirst).toBe(2);

    const second = await runAdversarialLoop(input);
    expect(second, JSON.stringify(second)).toMatchObject({
      decision: 'approved',
      finalEvaluatorTaskId: first.finalEvaluatorTaskId,
      ruleArtifactId: first.ruleArtifactId,
      principleArtifactId: first.principleArtifactId,
    });
    expect(h.adapter.startRunCalls).toHaveLength(executionsAfterFirst);

    const evaluatorRuns = await h.stateManager.getRunsByTask(first.finalEvaluatorTaskId);
    const authoritativeRunId = first.finalEvaluatorTaskId
      ? (await h.stateManager.getTask(first.finalEvaluatorTaskId))?.resultRef?.replace('evaluator://', '')
      : undefined;
    const authoritativeRun = evaluatorRuns.find((run) => run.runId === authoritativeRunId);
    expect(authoritativeRun?.executionStatus).toBe('succeeded');
    expect(authoritativeRun?.reason).toBe('task_completed');
    expect(authoritativeRun?.outputPayload).toBeTruthy();
  }, 60_000);

  it('recovers evaluator output after completion-intent terminal recovery without another model execution', async () => {
    const oldH = h;
    h = await makeHarness({
      gateDeps: makePassingGateDeps(),
      retryPolicyConfig: { baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });
    await oldH.stateManager.close();
    try { fs.rmSync(oldH.tmpDir, { recursive: true, force: true }); } catch { /* temp */ }

    const artificerCreation = await createLogicalSuccessorTask({
      stateManager: h.stateManager,
      parentTaskId: SCRIBE_TASK_ID,
      successorKind: 'artificer',
      channel: 'prompt',
      preferredTaskId: 'loop-intent-artificer-r1',
      metadata: {
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: SCRIBE_TASK_ID,
      },
    });
    if (artificerCreation.outcome !== 'created') throw new Error(`expected artificer creation, got ${artificerCreation.outcome}`);
    h.adapter.queueArtificer(makeArtificerOutput);
    expect((await h.artificerRunner.run(artificerCreation.task.taskId)).status).toBe('succeeded');

    const evaluatorCreation = await createLogicalSuccessorTask({
      stateManager: h.stateManager,
      parentTaskId: artificerCreation.task.taskId,
      successorKind: 'evaluator',
      channel: 'prompt',
      preferredTaskId: 'loop-intent-evaluator-r1',
      metadata: {
        dependencyTaskIds: [artificerCreation.task.taskId],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: artificerCreation.task.taskId,
      },
    });
    if (evaluatorCreation.outcome !== 'created') throw new Error(`expected evaluator creation, got ${evaluatorCreation.outcome}`);
    h.adapter.queueEvaluator(makeEvaluatorApproved);

    const mutableStateManager = h.stateManager as unknown as {
      markTaskSucceeded: RuntimeStateManager['markTaskSucceeded'];
    };
    const originalMarkSucceeded = mutableStateManager.markTaskSucceeded.bind(h.stateManager);
    let injectedTerminalWriteFailure = true;
    mutableStateManager.markTaskSucceeded = async (...args) => {
      if (injectedTerminalWriteFailure) {
        injectedTerminalWriteFailure = false;
        throw new Error('injected terminal success write failure');
      }
      return originalMarkSucceeded(...args);
    };
    let firstEvaluatorResult;
    try {
      firstEvaluatorResult = await h.evaluatorRunner.run(evaluatorCreation.task.taskId);
    } finally {
      mutableStateManager.markTaskSucceeded = originalMarkSucceeded;
    }
    expect(firstEvaluatorResult.status).toBe('retried');

    const interruptedPi = hydratePITaskRecord((await h.stateManager.getTask(evaluatorCreation.task.taskId))!);
    expect(interruptedPi?.completionIntent?.status).toBe('applied');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The second real runner acquisition resumes the applied completion intent.
    // No evaluator factory is queued here: any repeated model call makes the
    // scripted adapter fail the test instead of silently masking re-execution.
    const resumed = await h.evaluatorRunner.run(evaluatorCreation.task.taskId);
    expect(resumed.status).toBe('succeeded');

    const terminalTask = await h.stateManager.getTask(evaluatorCreation.task.taskId);
    expect(terminalTask?.status).toBe('succeeded');
    const authoritativeRunId = terminalTask?.resultRef?.replace('evaluator://', '');
    expect(authoritativeRunId).toBeTruthy();
    const runs = await h.stateManager.getRunsByTask(evaluatorCreation.task.taskId);
    const authoritativeRun = runs.find((run) => run.runId === authoritativeRunId);
    const terminalCompletionRun = runs.find((run) => run.executionStatus === 'succeeded' && run.reason === 'task_completed');
    expect(authoritativeRun?.outputPayload).toBeTruthy();
    expect(authoritativeRun?.executionStatus).not.toBe('succeeded');
    expect(terminalCompletionRun).toBeDefined();
    expect(terminalCompletionRun?.runId).not.toBe(authoritativeRun?.runId);

    const recovered = await h.evaluatorRunner.recoverSucceededResult(terminalTask!);
    expect(recovered, JSON.stringify(recovered)).toMatchObject({
      outcome: 'recovered',
      result: {
        taskId: evaluatorCreation.task.taskId,
        runId: authoritativeRunId,
      },
    });

    const executionsBeforeLoop = h.adapter.startRunCalls.length;
    const loop = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });
    expect(loop, JSON.stringify(loop)).toMatchObject({
      decision: 'approved',
      finalEvaluatorTaskId: evaluatorCreation.task.taskId,
    });
    expect(h.adapter.startRunCalls).toHaveLength(executionsBeforeLoop);
  }, 60_000);

  it('recovers approved-plus-failed-replay evidence as a repair-required round instead of rejecting raw metadata', async () => {
    const oldH = h;
    h = await makeHarness({ gateDeps: makeFailingGateDeps() });
    await oldH.stateManager.close();
    try { fs.rmSync(oldH.tmpDir, { recursive: true, force: true }); } catch { /* temp */ }
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorApproved);
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorApproved);
    const input = {
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    };

    const first = await runAdversarialLoop(input);
    expect(first.decision).toBe('rejected');
    expect(first.degradationReason).toContain('max_rounds_exhausted');
    const executionsAfterFirst = h.adapter.startRunCalls.length;
    expect(executionsAfterFirst).toBe(4);

    const second = await runAdversarialLoop(input);
    expect(second, JSON.stringify(second)).toMatchObject({
      decision: 'rejected',
      finalEvaluatorTaskId: first.finalEvaluatorTaskId,
    });
    expect(second.degradationReason).toContain('max_rounds_exhausted');
    expect(second.degradationReason).not.toContain('runner_decision_mismatch');
    expect(h.adapter.startRunCalls).toHaveLength(executionsAfterFirst);
  }, 60_000);

  it('recovers a partially completed chain: succeeded artificer is reused while evaluator executes once', async () => {
    const creation = await createLogicalSuccessorTask({
      stateManager: h.stateManager,
      parentTaskId: SCRIBE_TASK_ID,
      successorKind: 'artificer',
      channel: 'prompt',
      preferredTaskId: 'loop-partial-artificer',
      metadata: {
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: SCRIBE_TASK_ID,
      },
    });
    if (creation.outcome !== 'created') throw new Error(`expected artificer creation, got ${creation.outcome}`);
    h.adapter.queueArtificer(makeArtificerOutput);
    const direct = await h.artificerRunner.run(creation.task.taskId);
    expect(direct.status).toBe('succeeded');
    expect(h.adapter.startRunCalls).toHaveLength(1);

    h.adapter.queueEvaluator(makeEvaluatorApproved);
    const result = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    expect(result, JSON.stringify(result)).toMatchObject({ decision: 'approved', rounds: 1 });
    expect(h.adapter.startRunCalls).toHaveLength(2);
    expect(h.adapter.startRunCalls[1]?.taskId).toBe(result.finalEvaluatorTaskId);
    const artificerTasks = (await h.stateManager.listTasks()).filter((task) => task.taskKind === 'artificer');
    expect(artificerTasks.map((task) => task.taskId)).toEqual([creation.task.taskId]);
  }, 60_000);

  it('fails closed when a succeeded task has corrupted durable output and never re-executes it', async () => {
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorApproved);
    const input = {
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    };
    const first = await runAdversarialLoop(input);
    expect(first.decision).toBe('approved');
    const evaluatorTask = await h.stateManager.getTask(first.finalEvaluatorTaskId);
    const runId = evaluatorTask?.resultRef?.replace('evaluator://', '');
    expect(runId).toBeTruthy();
    await h.stateManager.runStore.updateRun(runId!, { outputPayload: '{corrupted' });
    const executionsAfterFirst = h.adapter.startRunCalls.length;

    const second = await runAdversarialLoop(input);
    expect(second.decision).toBe('rejected');
    expect(second.degradationReason).toContain('evaluator_recovery_invalid');
    expect(h.adapter.startRunCalls).toHaveLength(executionsAfterFirst);
    expect((await h.stateManager.getTask(first.finalEvaluatorTaskId))?.status).toBe('succeeded');
  }, 60_000);

  it('reopens the existing evaluator through the formal cascade before recovering a revised artificer epoch', async () => {
    const orchestrator = new InternalizationOrchestrator(
      { stateManager: h.stateManager },
      { owner: 'loop-test', runtimeKind: 'test-double', dryRun: true },
    );
    const input = {
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
      commitTaskTransition: (taskId: string) => orchestrator.commitNextTaskProposal(taskId),
    };
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorApproved);
    const first = await runAdversarialLoop(input);
    expect(first.decision).toBe('approved');

    const artificerTask = (await h.stateManager.listTasks()).find((task) => task.taskKind === 'artificer');
    expect(artificerTask).toBeDefined();
    const reopened = await reopenTaskForRevision(h.stateManager, artificerTask!.taskId, {
      reason: 'owner_requested_rule_revision',
      revisionCauseId: 'test-owner-artificer-revision-1',
    });
    expect(reopened).toMatchObject({ ok: true });
    expect((await h.stateManager.getTask(artificerTask!.taskId))?.status).toBe('pending');

    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorApproved);
    const second = await runAdversarialLoop(input);

    expect(second, JSON.stringify(second)).toMatchObject({
      decision: 'approved',
      finalEvaluatorTaskId: first.finalEvaluatorTaskId,
    });
    expect(h.adapter.startRunCalls).toHaveLength(4);
    expect(h.adapter.startRunCalls.map((call) => call.taskId)).toEqual([
      artificerTask!.taskId,
      first.finalEvaluatorTaskId,
      artificerTask!.taskId,
      first.finalEvaluatorTaskId,
    ]);

    const evaluatorTasks = (await h.stateManager.listTasks()).filter((task) => task.taskKind === 'evaluator');
    expect(evaluatorTasks.map((task) => task.taskId)).toEqual([first.finalEvaluatorTaskId]);
    const evaluatorPi = hydratePITaskRecord(evaluatorTasks[0]!);
    expect(evaluatorPi?.revisionCount).toBe(1);

    const revisedArtificer = await h.stateManager.getTask(artificerTask!.taskId);
    const revisedArtificerRunId = revisedArtificer?.resultRef?.replace('artificer://', '');
    expect(revisedArtificerRunId).toBeTruthy();
    const expectedArtificerArtifactId = `pi-art-${artificerTask!.taskId}-${revisedArtificerRunId}`;
    const evaluatorRuns = await h.stateManager.getRunsByTask(first.finalEvaluatorTaskId);
    expect(evaluatorRuns.filter((run) => run.executionStatus === 'succeeded')).toHaveLength(2);
    const latestEvaluatorRun = [...evaluatorRuns].sort((a, b) => a.attemptNumber - b.attemptNumber).at(-1);
    expect(latestEvaluatorRun?.outputPayload).toBeTruthy();
    const latestOutput = JSON.parse(latestEvaluatorRun!.outputPayload!) as { sourceArtificerArtifactId?: string };
    expect(latestOutput.sourceArtificerArtifactId).toBe(expectedArtificerArtifactId);
  }, 60_000);

  it.each([
    ['failed', 'artificer_successor_failed_terminal'],
    ['needs_human_review', 'artificer_successor_needs_human_review'],
  ] as const)('existing %s artificer successor is not bypassed or re-executed', async (status, expectedReason) => {
    await h.stateManager.createTask({
      taskId: `loop-terminal-artificer-${status}`,
      taskKind: 'artificer',
      status,
      attemptCount: 1,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: SCRIBE_TASK_ID,
      }),
    });

    const result = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    expect(result.decision).toBe('rejected');
    expect(result.degradationReason).toContain(expectedReason);
    expect(h.adapter.startRunCalls).toEqual([]);
    expect((await h.stateManager.getTask(`loop-terminal-artificer-${status}`))?.status).toBe(status);
  }, 60_000);

  it.each(['pending', 'retry_wait'] as const)('existing %s artificer successor continues without a duplicate logical task', async (status) => {
    const taskId = `loop-${status}-artificer`;
    await h.stateManager.createTask({
      taskId,
      taskKind: 'artificer',
      status,
      attemptCount: status === 'retry_wait' ? 1 : 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: SCRIBE_TASK_ID,
      }),
    });
    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator(makeEvaluatorApproved);

    const result = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    });

    expect(result, JSON.stringify(result)).toMatchObject({ decision: 'approved', rounds: 1 });
    expect(h.adapter.startRunCalls.map((call) => call.taskId)).toEqual([taskId, result.finalEvaluatorTaskId]);
    const artificerTasks = (await h.stateManager.listTasks()).filter((task) => task.taskKind === 'artificer');
    expect(artificerTasks.map((task) => task.taskId)).toEqual([taskId]);
  }, 60_000);

  it('resumes the reopened original evaluator after a crash between repair reopen and revision execution', async () => {
    // Build the pre-repair chain with real runner executions against real
    // SQLite/artifact persistence. The repair task shape mirrors the production
    // seeder; the transition itself below is performed only by the orchestrator.
    const artificerCreation = await createLogicalSuccessorTask({
      stateManager: h.stateManager,
      parentTaskId: SCRIBE_TASK_ID,
      successorKind: 'artificer',
      channel: 'prompt',
      preferredTaskId: 'loop-crash-artificer-r1',
      metadata: {
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: SCRIBE_TASK_ID,
      },
    });
    if (artificerCreation.outcome !== 'created') throw new Error(`expected round artificer creation, got ${artificerCreation.outcome}`);
    h.adapter.queueArtificer(makeArtificerOutput);
    const artificerResult = await h.artificerRunner.run(artificerCreation.task.taskId);
    expect(artificerResult.status).toBe('succeeded');
    const sourceArtificerArtifactId = artificerResult.artifactId;
    expect(sourceArtificerArtifactId).toBeTruthy();

    const evaluatorCreation = await createLogicalSuccessorTask({
      stateManager: h.stateManager,
      parentTaskId: artificerCreation.task.taskId,
      successorKind: 'evaluator',
      channel: 'prompt',
      preferredTaskId: 'loop-crash-evaluator-r1',
      metadata: {
        dependencyTaskIds: [artificerCreation.task.taskId],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: artificerCreation.task.taskId,
      },
    });
    if (evaluatorCreation.outcome !== 'created') throw new Error(`expected evaluator creation, got ${evaluatorCreation.outcome}`);
    h.adapter.queueEvaluator(makeEvaluatorNeedsRevision);
    const sourceEvaluatorResult = await h.evaluatorRunner.run(evaluatorCreation.task.taskId);
    expect(sourceEvaluatorResult.status).toBe('succeeded');

    const repairPayload = {
      requiredChanges: ['fix matcher'],
      concerns: ['code gap'],
      previousScore: 0.4,
      repairIteration: 1,
      sourceArtificerArtifactId: sourceArtificerArtifactId!,
      sourceEvaluatorTaskId: evaluatorCreation.task.taskId,
      sourceEvaluatorRunId: sourceEvaluatorResult.runId,
    };
    const repairCreation = await createLogicalSuccessorTask({
      stateManager: h.stateManager,
      parentTaskId: evaluatorCreation.task.taskId,
      successorKind: 'artificer',
      channel: 'prompt',
      preferredTaskId: artificerRepairTaskId(evaluatorCreation.task.taskId, 1),
      metadata: {
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: evaluatorCreation.task.taskId,
        repairPayload,
      },
    });
    if (repairCreation.outcome !== 'created') throw new Error(`expected repair creation, got ${repairCreation.outcome}`);
    h.adapter.queueArtificer(makeArtificerOutput);
    expect((await h.artificerRunner.run(repairCreation.task.taskId)).status).toBe('succeeded');

    const orchestrator = new InternalizationOrchestrator(
      { stateManager: h.stateManager },
      { owner: 'loop-test', runtimeKind: 'test-double', dryRun: true },
    );
    const baseLoopInput = {
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
    };

    // First entry commits the formal reopen, then crashes before the reopened
    // evaluator can run. The throw is deliberately outside the evaluator runner:
    // it models process termination after the commit transaction succeeded.
    const crashed = await runAdversarialLoop({
      ...baseLoopInput,
      commitTaskTransition: async (repairTaskId) => {
        const commit = await orchestrator.commitNextTaskProposal(repairTaskId);
        if (commit.decision === 'revision_reopened') throw new Error('simulated crash after formal reopen');
        return commit;
      },
    });
    expect(crashed.decision).toBe('rejected');
    const reopenedAfterCrash = hydratePITaskRecord((await h.stateManager.getTask(evaluatorCreation.task.taskId))!);
    expect(reopenedAfterCrash).toMatchObject({
      taskId: evaluatorCreation.task.taskId,
      status: 'pending',
      revisionCount: 1,
    });
    expect(reopenedAfterCrash?.dependencyTaskIds).toEqual([repairCreation.task.taskId]);
    const callsBeforeResume = h.adapter.startRunCalls.length;

    const bounded = await runAdversarialLoop({
      ...baseLoopInput,
      maxRounds: 1,
      commitTaskTransition: (repairTaskId) => orchestrator.commitNextTaskProposal(repairTaskId),
    });
    expect(bounded, JSON.stringify(bounded)).toMatchObject({
      decision: 'rejected',
      rounds: 1,
      finalEvaluatorTaskId: evaluatorCreation.task.taskId,
    });
    expect(bounded.degradationReason).toContain('max_rounds_exhausted_before_revision_round_2');
    expect(h.adapter.startRunCalls).toHaveLength(callsBeforeResume);
    const boundedEvaluator = hydratePITaskRecord((await h.stateManager.getTask(evaluatorCreation.task.taskId))!);
    expect(boundedEvaluator).toMatchObject({ status: 'pending', revisionCount: 1 });

    const approvedFactory: EvaluatorFactory = (taskId, artificerArtifactId) => ({
      ...makeEvaluatorApproved(taskId, artificerArtifactId),
      evaluation: {
        ...makeEvaluatorApproved(taskId, artificerArtifactId).evaluation,
        priorRequirementStatuses: [{ id: 'req-1', status: 'resolved' }],
        requirementLedger: [{ id: 'req-1', statement: 'fix matcher', status: 'resolved' }],
      },
    });
    h.adapter.queueEvaluator(approvedFactory);
    const resumed = await runAdversarialLoop({
      ...baseLoopInput,
      commitTaskTransition: (repairTaskId) => orchestrator.commitNextTaskProposal(repairTaskId),
    });

    expect(resumed, JSON.stringify(resumed)).toMatchObject({
      decision: 'approved',
      rounds: 2,
      finalEvaluatorTaskId: evaluatorCreation.task.taskId,
    });
    expect(h.adapter.startRunCalls.length - callsBeforeResume).toBe(1);
    expect(h.adapter.startRunCalls.at(-1)?.taskId).toBe(evaluatorCreation.task.taskId);
    const finalEvaluator = hydratePITaskRecord((await h.stateManager.getTask(evaluatorCreation.task.taskId))!);
    expect(finalEvaluator?.revisionCount).toBe(1);
    const evaluatorTasks = (await h.stateManager.listTasks()).filter((task) => task.taskKind === 'evaluator');
    expect(evaluatorTasks.map((task) => task.taskId)).toEqual([evaluatorCreation.task.taskId]);
    const evaluatorRuns = await h.stateManager.getRunsByTask(evaluatorCreation.task.taskId);
    expect(evaluatorRuns.filter((run) => run.executionStatus === 'succeeded')).toHaveLength(2);

    const callsBeforeCompletedRecovery = h.adapter.startRunCalls.length;
    const completedRecovery = await runAdversarialLoop({
      ...baseLoopInput,
      maxRounds: 1,
      commitTaskTransition: (repairTaskId) => orchestrator.commitNextTaskProposal(repairTaskId),
    });
    expect(completedRecovery, JSON.stringify(completedRecovery)).toMatchObject({
      decision: 'approved',
      rounds: 2,
      finalEvaluatorTaskId: evaluatorCreation.task.taskId,
    });
    expect(h.adapter.startRunCalls).toHaveLength(callsBeforeCompletedRecovery);
  }, 60_000);

  it('approved output with owner-provenance transition override reaches the existing repair instead of stopping without a rule artifact', async () => {
    const artificerCreation = await createLogicalSuccessorTask({
      stateManager: h.stateManager,
      parentTaskId: SCRIBE_TASK_ID,
      successorKind: 'artificer',
      channel: 'prompt',
      preferredTaskId: 'loop-owner-stamp-artificer-r1',
      metadata: {
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: SCRIBE_TASK_ID,
      },
    });
    if (artificerCreation.outcome !== 'created') throw new Error(`expected artificer creation, got ${artificerCreation.outcome}`);
    h.adapter.queueArtificer(makeArtificerOutput);
    const artificerResult = await h.artificerRunner.run(artificerCreation.task.taskId);
    expect(artificerResult.status).toBe('succeeded');

    const evaluatorCreation = await createLogicalSuccessorTask({
      stateManager: h.stateManager,
      parentTaskId: artificerCreation.task.taskId,
      successorKind: 'evaluator',
      channel: 'prompt',
      preferredTaskId: 'loop-owner-stamp-evaluator-r1',
      metadata: {
        dependencyTaskIds: [artificerCreation.task.taskId],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: artificerCreation.task.taskId,
      },
    });
    if (evaluatorCreation.outcome !== 'created') throw new Error(`expected evaluator creation, got ${evaluatorCreation.outcome}`);
    h.adapter.queueEvaluator(makeEvaluatorApproved);
    expect((await h.evaluatorRunner.run(evaluatorCreation.task.taskId)).status).toBe('succeeded');

    // The owner-provenance recovery trigger itself is covered by the dedicated
    // evaluator test. Here we place the same durable transition marker on the
    // evaluator and prove the synchronous loop consumes the formal decision.
    const evaluatorRow = await h.stateManager.getTask(evaluatorCreation.task.taskId);
    const evaluatorPi = evaluatorRow ? hydratePITaskRecord(evaluatorRow) : null;
    if (!evaluatorPi?.completionIntent) throw new Error('expected completion intent on approved evaluator');
    await h.stateManager.updateTask(evaluatorCreation.task.taskId, {
      diagnosticJson: createPITaskDiagnosticJson({
        ...evaluatorPi,
        completionIntent: {
          ...evaluatorPi.completionIntent,
          transitionOverrideReason: 'owner_golden_trace_provenance_missing',
        },
      }),
    });
    const repairPayload = {
      requiredChanges: ['restore owner provenance'],
      concerns: [],
      previousScore: 0.9,
      repairIteration: 1,
      sourceArtificerArtifactId: artificerResult.artifactId!,
      sourceEvaluatorTaskId: evaluatorCreation.task.taskId,
    };
    const repairCreation = await createLogicalSuccessorTask({
      stateManager: h.stateManager,
      parentTaskId: evaluatorCreation.task.taskId,
      successorKind: 'artificer',
      channel: 'prompt',
      preferredTaskId: artificerRepairTaskId(evaluatorCreation.task.taskId, 1),
      metadata: {
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: evaluatorCreation.task.taskId,
        repairPayload,
      },
    });
    if (repairCreation.outcome !== 'created') throw new Error(`expected repair creation, got ${repairCreation.outcome}`);

    h.adapter.queueArtificer(makeArtificerOutput);
    h.adapter.queueEvaluator((taskId, artificerArtifactId) => ({
      ...makeEvaluatorApproved(taskId, artificerArtifactId),
      evaluation: {
        ...makeEvaluatorApproved(taskId, artificerArtifactId).evaluation,
        priorRequirementStatuses: [{ id: 'req-1', status: 'resolved' }],
        requirementLedger: [{ id: 'req-1', statement: 'restore owner provenance', status: 'resolved' }],
      },
    }));
    const orchestrator = new InternalizationOrchestrator(
      { stateManager: h.stateManager },
      { owner: 'loop-test', runtimeKind: 'test-double', dryRun: true },
    );
    const result = await runAdversarialLoop({
      artificerRunner: h.artificerRunner,
      artifactStore: h.artifactStore,
      evaluatorRunner: h.evaluatorRunner,
      stateManager: h.stateManager,
      scribeTaskId: SCRIBE_TASK_ID,
      commitTaskTransition: (repairTaskId) => orchestrator.commitNextTaskProposal(repairTaskId),
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      decision: 'approved',
      rounds: 2,
      finalEvaluatorTaskId: evaluatorCreation.task.taskId,
    });
    expect(h.adapter.startRunCalls.map((call) => call.taskId)).toEqual([
      artificerCreation.task.taskId,
      evaluatorCreation.task.taskId,
      repairCreation.task.taskId,
      evaluatorCreation.task.taskId,
    ]);
    const evaluatorTasks = (await h.stateManager.listTasks()).filter((task) => task.taskKind === 'evaluator');
    expect(evaluatorTasks.map((task) => task.taskId)).toEqual([evaluatorCreation.task.taskId]);
    expect(hydratePITaskRecord(evaluatorTasks[0]!)?.revisionCount).toBe(1);
  }, 60_000);

  it('existing leased artificer successor is not preempted by a second executor', async () => {
    const creation = await createLogicalSuccessorTask({
      stateManager: h.stateManager,
      parentTaskId: SCRIBE_TASK_ID,
      successorKind: 'artificer',
      channel: 'prompt',
      preferredTaskId: 'loop-leased-artificer',
      metadata: {
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: SCRIBE_TASK_ID,
      },
    });
    if (creation.outcome !== 'created') throw new Error(`expected artificer creation, got ${creation.outcome}`);
    // A second independent RuntimeStateManager owns the lease: the loop must
    // respect the real cross-connection lease rather than treating same-object
    // state as a test-only shortcut.
    const foreignManager = new RuntimeStateManager({ workspaceDir: h.tmpDir });
    await foreignManager.initialize();
    try {
      const lease = await foreignManager.acquireLeaseDetailed({
        taskId: creation.task.taskId,
        owner: 'foreign-consumer',
        runtimeKind: 'test-double',
      });
      expect(lease.task.status).toBe('leased');
      expect(lease.runId).toBeTruthy();

      const result = await runAdversarialLoop({
        artificerRunner: h.artificerRunner,
        artifactStore: h.artifactStore,
        evaluatorRunner: h.evaluatorRunner,
        stateManager: h.stateManager,
        scribeTaskId: SCRIBE_TASK_ID,
      });

      expect(result.decision).toBe('rejected');
      expect(result.degradationReason).toContain('artificer_successor_leased_active');
      expect(h.adapter.startRunCalls).toEqual([]);
      const leased = await foreignManager.getTask(creation.task.taskId);
      expect(leased?.status).toBe('leased');
      expect(leased?.leaseOwner).toBe('foreign-consumer');
    } finally {
      await foreignManager.close();
    }
  }, 60_000);
});
