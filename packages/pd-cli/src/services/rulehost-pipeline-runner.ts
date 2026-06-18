/**
 * RuleHost Pipeline Runner — full-chain internalization driver (PRI-429).
 *
 * Drives a pain signal all the way to a validated rule artifact in ONE call:
 *   pain → dreamer → philosopher → scribe → artificer↔evaluator adversarial loop
 *
 * This is the "last mile" wiring that makes `runAdversarialLoop` reachable
 * from a real host entry point (the PRI-428 pr-review finding: the loop had no
 * production caller). Operators invoke it via
 *   `pd runtime internalization run-rulehost --pain-id <id>`
 *
 * Design:
 *   - Does NOT reuse the lease-based InternalizationOrchestrator. Instead it
 *     chains runners directly (mirrors full-chain-real-llm.test.ts), because
 *     the lease model is single-step + successor-proposal and cannot host a
 *     synchronous multi-round loop.
 *   - The artificer↔evaluator stage delegates to `runAdversarialLoop` (PRI-428),
 *     which never throws and degrades to { decision: 'rejected' } with a reason.
 *   - gateDeps (the sandbox adapter) is built from `compileDemoRule` +
 *     `evaluateInRefinerSandbox`. Per the Explore finding, `compileDemoRule` is
 *     byte-equivalent to openclaw-plugin's `loadRuleImplementationModule`; the
 *     duplication is a package-boundary necessity (pd-cli cannot import
 *     openclaw-plugin), not a capability gap.
 *
 * @see docs/plans/rulehost-mvp-activation.md
 * @see runAdversarialLoop in @principles/core/runtime-v2
 */
import {
  RuntimeStateManager,
  StoreEventEmitter,
  DreamerRunner,
  DefaultDreamerValidator,
  PhilosopherRunner,
  DefaultPhilosopherValidator,
  ScribeRunner,
  DefaultScribeValidator,
  ArtificerRunner,
  DefaultArtificerValidator,
  EvaluatorRunner,
  DefaultEvaluatorValidator,
  createPITaskDiagnosticJson,
  runAdversarialLoop,
  evaluateInRefinerSandbox,
  DEFAULT_MAX_ROUNDS,
} from '@principles/core/runtime-v2';
import type {
  AdversarialLoopResult,
  PDRuntimeAdapter,
  PeerRunnerResult,
  RefinerRuleHostGateDeps,
  PIArtifactStore,
} from '@principles/core/runtime-v2';
/* eslint-disable @typescript-eslint/no-use-before-define -- helpers declared after main, matching codebase convention */
import { compileDemoRule } from './demo-rule-compiler.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RuleHostPipelineOptions {
  /** Workspace directory containing .state/ (SQLite stores). */
  readonly workspaceDir: string;
  /** Pain ID whose internalization chain to drive. */
  readonly painId: string;
  /**
   * Runtime adapter (LLM). Caller constructs it (PiAi / test-double) so the
   * service stays runtime-agnostic. Mirrors full-chain-real-llm.test.ts.
   */
  readonly runtimeAdapter: PDRuntimeAdapter;
  /** Internalization channel for created tasks (default 'code_tool_hook'). */
  readonly channel?: 'prompt' | 'code_tool_hook' | 'defer_archive';
  /** Max adversarial rounds (PRD cap = 2). */
  readonly maxRounds?: number;
  /** Per-LLM-call timeout (default 300_000). */
  readonly timeoutMs?: number;
  /** Runner poll interval (default 100). */
  readonly pollIntervalMs?: number;
  /** Correlation prefix for task IDs. */
  readonly correlationId?: string;
  /** Progress callback (stage start/complete). Optional. */
  readonly onProgress?: (stage: string, status: 'start' | 'succeeded' | 'failed' | 'degraded', detail?: string) => void;
  /**
   * Called once after the internal RuntimeStateManager + artifactStore are
   * constructed, so the caller (e.g. a test-double adapter) can wire the store
   * for artifactId resolution. Optional.
   */
  readonly onStoreReady?: (store: PIArtifactStore) => void;
}

export type RuleHostPipelineStageStatus = 'succeeded' | 'failed' | 'skipped' | 'degraded';

export interface RuleHostPipelineStage {
  readonly name: 'pain_lookup' | 'dreamer' | 'philosopher' | 'scribe' | 'adversarial_loop';
  readonly status: RuleHostPipelineStageStatus;
  readonly taskId?: string;
  readonly reason?: string;
}

export interface RuleHostPipelineResult {
  /** Final outcome mirroring the adversarial loop decision. */
  readonly decision: 'approved' | 'rejected';
  readonly painId: string;
  readonly stages: RuleHostPipelineStage[];
  /** Scribe task that fed the adversarial loop. */
  readonly scribeTaskId: string | null;
  /** From the adversarial loop result, when reached. */
  readonly adversarialLoop?: AdversarialLoopResult;
  /** Rule artifact ID when approved; null otherwise. */
  readonly ruleArtifactId: string | null;
  /** Principle artifact ID (prompt-channel fallback, always present when scribe ran). */
  readonly principleArtifactId: string | null;
  /** Structured reason when decision === 'rejected'. */
  readonly degradationReason?: string;
}

// ── gateDeps builder ─────────────────────────────────────────────────────────

/**
 * Build the sandbox gate deps for adversarial replay.
 *
 * `compileDemoRule` is byte-equivalent to openclaw-plugin's
 * `loadRuleImplementationModule` (same vm.createContext, same normalize, same
 * evaluate-shape check). pd-cli cannot import openclaw-plugin (package
 * boundary), so this duplicate is intentional and capability-identical, not a
 * stripped demo. See demo-rule-compiler.ts header comment.
 */
export function createSandboxGateDeps(): RefinerRuleHostGateDeps {
  return {
    evaluateInSandbox: (code, goldenTrace, opts) => {
      // compileDemoRule throws on bad code; evaluateInRefinerSandbox catches
      // its own runtime throws and classifies them as validation_failed /
      // runtime_error. So a throwing compile surfaces as a sandbox failure,
      // not an uncaught exception to the gate.
      const evaluateCode = compileDemoRule(code, 'rulehost-pipeline');
      return evaluateInRefinerSandbox(code, goldenTrace, { evaluateCode, ...opts });
    },
  };
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 100;

export async function runRuleHostPipeline(opts: RuleHostPipelineOptions): Promise<RuleHostPipelineResult> {
  const channel = opts.channel ?? 'code_tool_hook';
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const correlation = opts.correlationId ?? `rulehost-${opts.painId}`;
  const onProgress = opts.onProgress ?? (() => { /* noop */ });

  const stages: RuleHostPipelineStage[] = [];
  const stateManager = new RuntimeStateManager({ workspaceDir: opts.workspaceDir });
  await stateManager.initialize();

  try {
    const artifactStore = stateManager.piArtifactStore;
    const eventEmitter = new StoreEventEmitter();
    // Allow the caller's adapter to resolve real artifactIds (needed by
    // test-double adapters whose scripted outputs must match store-assigned IDs).
    opts.onStoreReady?.(artifactStore);
    const owner = 'rulehost-pipeline';
    const runtimeKind = opts.runtimeAdapter.kind();
    const runnerOpts = { owner, runtimeKind, pollIntervalMs, timeoutMs };

    // ── Stage: pain lookup ──
    // Find a dreamer task already seeded for this pain (the pain→dreamer bridge
    // runs via `pd pain record` → PainSignalBridge.onPainDetected). We need the
    // dreamer task to start the chain. If none exists, the operator must run
    // `pd pain record` first — fail loud with guidance.
    onProgress('pain_lookup', 'start', `painId=${opts.painId}`);
    const dreamerSeedTaskId = await findDreamerTaskForPain(stateManager, opts.painId);
    if (!dreamerSeedTaskId) {
      stages.push({ name: 'pain_lookup', status: 'failed', reason: 'no_dreamer_task_seeded_for_pain' });
      onProgress('pain_lookup', 'failed', 'no dreamer task seeded');
      return rejectedResult(opts.painId, stages, 'no_dreamer_task_seeded_for_pain: run `pd pain record` first');
    }
    stages.push({ name: 'pain_lookup', status: 'succeeded', taskId: dreamerSeedTaskId });
    onProgress('pain_lookup', 'succeeded', `dreamerTaskId=${dreamerSeedTaskId}`);

    // ── Stage: dreamer ──
    onProgress('dreamer', 'start');
    const dreamerRunner = new DreamerRunner(
      { stateManager, runtimeAdapter: opts.runtimeAdapter, eventEmitter, validator: new DefaultDreamerValidator(), artifactStore },
      runnerOpts,
    );
    const dreamerResult = await runStage(dreamerRunner, dreamerSeedTaskId);
    stages.push(stageFromResult('dreamer', dreamerSeedTaskId, dreamerResult));
    if (dreamerResult.status !== 'succeeded') {
      onProgress('dreamer', 'failed', dreamerResult.failureReason);
      return rejectedResult(opts.painId, stages, `dreamer_failed: ${dreamerResult.failureReason ?? dreamerResult.status}`);
    }
    onProgress('dreamer', 'succeeded');

    // ── Stage: philosopher ──
    onProgress('philosopher', 'start');
    const philosopherTaskId = `${correlation}-philosopher-${Date.now().toString(36)}`;
    await createInternalizationTask(stateManager, philosopherTaskId, 'philosopher', [dreamerSeedTaskId], channel, timeoutMs);
    const philosopherRunner = new PhilosopherRunner(
      { stateManager, runtimeAdapter: opts.runtimeAdapter, eventEmitter, validator: new DefaultPhilosopherValidator(), artifactStore },
      runnerOpts,
    );
    const philosopherResult = await runStage(philosopherRunner, philosopherTaskId);
    stages.push(stageFromResult('philosopher', philosopherTaskId, philosopherResult));
    if (philosopherResult.status !== 'succeeded') {
      onProgress('philosopher', 'failed', philosopherResult.failureReason);
      return rejectedResult(opts.painId, stages, `philosopher_failed: ${philosopherResult.failureReason ?? philosopherResult.status}`);
    }
    onProgress('philosopher', 'succeeded');

    // ── Stage: scribe ──
    onProgress('scribe', 'start');
    const scribeTaskId = `${correlation}-scribe-${Date.now().toString(36)}`;
    await createInternalizationTask(stateManager, scribeTaskId, 'scribe', [philosopherTaskId], channel, timeoutMs);
    const scribeRunner = new ScribeRunner(
      { stateManager, runtimeAdapter: opts.runtimeAdapter, eventEmitter, validator: new DefaultScribeValidator(), artifactStore },
      runnerOpts,
    );
    const scribeResult = await runStage(scribeRunner, scribeTaskId);
    stages.push(stageFromResult('scribe', scribeTaskId, scribeResult));
    if (scribeResult.status !== 'succeeded') {
      onProgress('scribe', 'failed', scribeResult.failureReason);
      return rejectedResult(opts.painId, stages, `scribe_failed: ${scribeResult.failureReason ?? scribeResult.status}`);
    }
    onProgress('scribe', 'succeeded');

    // ── Stage: adversarial loop (artificer↔evaluator) ──
    onProgress('adversarial_loop', 'start');
    const artificerRunner = new ArtificerRunner(
      { stateManager, runtimeAdapter: opts.runtimeAdapter, eventEmitter, validator: new DefaultArtificerValidator(), artifactStore },
      runnerOpts,
    );
    const evaluatorRunner = new EvaluatorRunner(
      { stateManager, runtimeAdapter: opts.runtimeAdapter, eventEmitter, validator: new DefaultEvaluatorValidator(), artifactStore },
      { ...runnerOpts, gateDeps: createSandboxGateDeps() },
    );

    const loopResult = await runAdversarialLoop({
      artificerRunner,
      evaluatorRunner,
      stateManager,
      artifactStore,
      scribeTaskId,
      maxRounds,
      correlationId: correlation,
      channel,
    });

    const loopStatus: RuleHostPipelineStageStatus = loopResult.decision === 'approved' ? 'succeeded' : 'degraded';
    stages.push({ name: 'adversarial_loop', status: loopStatus, taskId: loopResult.finalEvaluatorTaskId, reason: loopResult.degradationReason });
    onProgress('adversarial_loop', loopResult.decision === 'approved' ? 'succeeded' : 'degraded', loopResult.degradationReason);

    return {
      decision: loopResult.decision,
      painId: opts.painId,
      stages,
      scribeTaskId,
      adversarialLoop: loopResult,
      ruleArtifactId: loopResult.ruleArtifactId,
      principleArtifactId: loopResult.principleArtifactId,
      degradationReason: loopResult.degradationReason,
    };
  } finally {
    try { stateManager.close(); } catch { /* best-effort cleanup */ }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function findDreamerTaskForPain(stateManager: RuntimeStateManager, painId: string): Promise<string | null> {
  // The pain→dreamer bridge (PainSignalBridge.onDiagnosisComplete) seeds a
  // dreamer task. The pain linkage may be in the taskId (when seeded with a
  // pain-derived correlation id) or in diagnosticJson (correlationId field).
  // Scan dreamer tasks for either.
  const tasks = await stateManager.listTasks();
  const dreamerTasks = tasks.filter((t) => t.taskKind === 'dreamer');
  for (const t of dreamerTasks) {
    if (t.taskId.includes(painId)) return t.taskId;
    const diag = typeof t.diagnosticJson === 'string' ? t.diagnosticJson : '';
    if (diag.includes(painId)) return t.taskId;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/max-params
async function createInternalizationTask(
  stateManager: RuntimeStateManager,
  taskId: string,
  taskKind: string,
  dependencyTaskIds: string[],
  channel: 'prompt' | 'code_tool_hook' | 'defer_archive',
  timeoutMs: number,
): Promise<void> {
  await stateManager.createTask({
    taskId,
    taskKind,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds,
      channel,
      timeoutMs,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runStage(runner: { run(id: string): Promise<PeerRunnerResult<any>> }, taskId: string) {
  return runner.run(taskId);
}

function stageFromResult(
  name: RuleHostPipelineStage['name'],
  taskId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: PeerRunnerResult<any>,
): RuleHostPipelineStage {
  return {
    name,
    taskId,
    status: result.status === 'succeeded' ? 'succeeded' : 'failed',
    reason: result.status !== 'succeeded' ? (result.failureReason ?? result.status) : undefined,
  };
}

function rejectedResult(painId: string, stages: RuleHostPipelineStage[], degradationReason: string): RuleHostPipelineResult {
  return {
    decision: 'rejected',
    painId,
    stages,
    scribeTaskId: null,
    ruleArtifactId: null,
    principleArtifactId: null,
    degradationReason,
  };
}
