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

/**
 * Code-rule capability (atomic: ArtificerL2 + Evaluator).
 *
 * Per the user correction (2026-06-18): ArtificerL2 and Evaluator are atomic —
 * both must run or neither runs. When enabled, the adversarial loop runs with
 * the artificerAdapter (L2 write-test-fix). When disabled or not provided, the
 * pipeline degrades to text-principle-only.
 *
 * The caller (CLI handler) resolves per-agent config (enabled/runtimeProfile)
 * and constructs the ArtificerL2Adapter when both artificer + evaluator are
 * enabled. The pipeline runner branches on `enabled` — it does NOT do config
 * resolution itself (separation of concerns: service vs I/O).
 */
export interface CodeRuleCapability {
  /** Whether the capability is enabled (atomic: both artificer + evaluator enabled in config). */
  readonly enabled: boolean;
  /**
   * The ArtificerL2Adapter (or test-double) for the artificer stage. Required
   * when enabled. When enabled, this adapter replaces the base runtimeAdapter
   * for the ArtificerRunner only; EvaluatorRunner still uses the base adapter.
   * Ignored when disabled (may be omitted or set to the base adapter).
   */
  readonly artificerAdapter?: PDRuntimeAdapter;
  /** Structured reason when disabled (for degradation reporting). Required when disabled. */
  readonly disabledReason?: string;
}

export interface RuleHostPipelineOptions {
  /** Workspace directory containing .state/ (SQLite stores). */
  readonly workspaceDir: string;
  /** Pain ID whose internalization chain to drive. */
  readonly painId: string;
  /**
   * Runtime adapter (LLM). Caller constructs it (PiAi / test-double) so the
   * service stays runtime-agnostic. Mirrors full-chain-real-llm.test.ts.
   *
   * Used for: dreamer, philosopher, scribe, and evaluator (when capability ON).
   * The artificer stage uses codeRuleCapability.artificerAdapter when enabled.
   */
  readonly runtimeAdapter: PDRuntimeAdapter;
  /**
   * Code-rule capability (atomic: ArtificerL2 + Evaluator). When omitted, the
   * capability is treated as OFF with reason 'code_rule_capability not provided'.
   */
  readonly codeRuleCapability?: CodeRuleCapability;
  /** Internalization channel for created tasks (default 'code_tool_hook'). */
  readonly channel?: 'prompt' | 'code_tool_hook' | 'defer_archive';
  /** Max adversarial rounds (PRD cap = 2). */
  readonly maxRounds?: number;
  /** Per-LLM-call timeout (default 300_000). */
  readonly timeoutMs?: number;
  /** Runner poll interval (default 100). */
  readonly pollIntervalMs?: number;
  /**
   * Max stage retry attempts for transient `retried` status (default 2).
   * Each retry gets fresh state from the state manager (Runtime Contract Rule 7).
   * When exhausted, the stage is marked 'degraded' with a structured reason.
   */
  readonly maxStageRetries?: number;
  /** Correlation prefix for task IDs. */
  readonly correlationId?: string;
  /** Progress callback (stage start/complete). Optional. */
  readonly onProgress?: (stage: string, status: 'start' | 'succeeded' | 'failed' | 'degraded' | 'skipped', detail?: string) => void;
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

/**
 * Final pipeline decision.
 *
 * - `candidate_ready_for_owner_review`: adversarial loop approved. A validated
 *   rule artifact exists and is WAITING for owner review. This is NOT owner
 *   approval — it means the candidate is ready for the owner to review.
 * - `text_principle_only`: code-rule capability OFF (artificer or evaluator
 *   disabled). No rule artifact; a text principle artifact is produced for
 *   prompt-channel fallback.
 * - `generation_rejected`: pipeline failed (no dreamer task, stage failure, or
 *   evaluator rejected the candidate). No rule artifact.
 */
export interface RuleHostPipelineResult {
  readonly decision: 'candidate_ready_for_owner_review' | 'text_principle_only' | 'generation_rejected';
  readonly painId: string;
  readonly stages: RuleHostPipelineStage[];
  /** Scribe task that fed the adversarial loop (or text-principle path). */
  readonly scribeTaskId: string | null;
  /** From the adversarial loop result, when reached. */
  readonly adversarialLoop?: AdversarialLoopResult;
  /** Rule artifact ID when candidate_ready_for_owner_review; null otherwise. */
  readonly ruleArtifactId: string | null;
  /** Principle artifact ID (always present when scribe ran). */
  readonly principleArtifactId: string | null;
  /** Structured reason when decision is not candidate_ready_for_owner_review. */
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
      // compileDemoRule throws on bad code. The throw propagates out of
      // evaluateInSandbox; EvaluatorRunner (and runAdversarialLoop's
      // evaluator_run_threw catch) classifies it as a sandbox failure, so it
      // surfaces as a rejected round rather than an uncaught exception.
      // evaluateInRefinerSandbox separately catches its own runtime throws
      // (from executing the evaluate function) and classifies them as
      // validation_failed / runtime_error.
      const evaluateCode = compileDemoRule(code, 'rulehost-pipeline');
      return evaluateInRefinerSandbox(code, goldenTrace, { evaluateCode, ...opts });
    },
  };
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_MAX_STAGE_RETRIES = 2;

export async function runRuleHostPipeline(opts: RuleHostPipelineOptions): Promise<RuleHostPipelineResult> {
  const channel = opts.channel ?? 'code_tool_hook';
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const maxStageRetries = opts.maxStageRetries ?? DEFAULT_MAX_STAGE_RETRIES;
  const correlation = opts.correlationId ?? `rulehost-${opts.painId}`;
  const onProgress = opts.onProgress ?? (() => { /* noop */ });

  // ── Resolve code-rule capability (atomic: ArtificerL2 + Evaluator) ──
  // Per user correction (2026-06-18): both must be enabled or neither runs.
  // When OFF, degrade to text-principle-only after scribe. When ON, run the
  // adversarial loop with the artificerAdapter (L2 write-test-fix).
  const capability = opts.codeRuleCapability;
  const capabilityEnabled = capability?.enabled === true;
  const capabilityDisabledReason = capability?.enabled === false
    ? (capability.disabledReason ?? 'code_rule_capability is disabled')
    : 'code_rule_capability not provided — default OFF (set codeRuleCapability.enabled=true when both artificer + evaluator agents are enabled)';

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
    //
    // D fix (PRI-429): exact sourcePainId match via Object.hasOwn on parsed
    // diagnosticJson. No substring matching (pain-1 must NOT match pain-10).
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
    const dreamerResult = await runStage(dreamerRunner, dreamerSeedTaskId, { maxStageRetries, pollIntervalMs });
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
    const philosopherResult = await runStage(philosopherRunner, philosopherTaskId, { maxStageRetries, pollIntervalMs });
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
    const scribeResult = await runStage(scribeRunner, scribeTaskId, { maxStageRetries, pollIntervalMs });
    stages.push(stageFromResult('scribe', scribeTaskId, scribeResult));
    if (scribeResult.status !== 'succeeded') {
      onProgress('scribe', 'failed', scribeResult.failureReason);
      return rejectedResult(opts.painId, stages, `scribe_failed: ${scribeResult.failureReason ?? scribeResult.status}`);
    }
    onProgress('scribe', 'succeeded');

    // ── Atomic capability branching ──
    // Per user correction (2026-06-18): ArtificerL2 + Evaluator are atomic.
    // When OFF (or not provided), skip the adversarial loop entirely and
    // degrade to text-principle-only. The scribe's principle artifact remains
    // for prompt-channel fallback.
    if (!capabilityEnabled) {
      stages.push({ name: 'adversarial_loop', status: 'skipped', reason: capabilityDisabledReason });
      onProgress('adversarial_loop', 'skipped', capabilityDisabledReason);
      return await textPrincipleOnlyResult({ painId: opts.painId, stages, scribeTaskId, disabledReason: capabilityDisabledReason, artifactStore });
    }

    // ── Stage: adversarial loop (artificer↔evaluator) ──
    // Capability ON: use the artificerAdapter (L2 write-test-fix) for the
    // artificer stage, and the base runtimeAdapter for the evaluator stage.
    if (!capability?.artificerAdapter) {
      // Contract violation: enabled but no adapter provided. Fail loud.
      stages.push({ name: 'adversarial_loop', status: 'failed', reason: 'artificerAdapter not provided' });
      onProgress('adversarial_loop', 'failed', 'artificerAdapter not provided');
      return rejectedResult(opts.painId, stages, 'code_rule_capability enabled but artificerAdapter not provided');
    }
    onProgress('adversarial_loop', 'start');
    const artificerRunner = new ArtificerRunner(
      { stateManager, runtimeAdapter: capability.artificerAdapter, eventEmitter, validator: new DefaultArtificerValidator(), artifactStore },
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

    // Map adversarial loop decision to pipeline decision:
    //   'approved' → candidate_ready_for_owner_review (NOT owner approval)
    //   'rejected' → generation_rejected
    const pipelineDecision = loopResult.decision === 'approved'
      ? 'candidate_ready_for_owner_review' as const
      : 'generation_rejected' as const;

    return {
      decision: pipelineDecision,
      painId: opts.painId,
      stages,
      scribeTaskId,
      adversarialLoop: loopResult,
      ruleArtifactId: loopResult.ruleArtifactId,
      principleArtifactId: loopResult.principleArtifactId,
      degradationReason: loopResult.degradationReason,
    };
  } finally {
    try { await stateManager.close(); } catch { /* best-effort cleanup */ }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the dreamer task seeded for a given pain ID.
 *
 * D fix (PRI-429): exact sourcePainId match via Object.hasOwn on parsed
 * diagnosticJson. No substring matching — 'pain-1' must NOT match 'pain-10'.
 *
 * The sourcePainId is stored as a top-level key in diagnosticJson (outside the
 * pi_metadata envelope), mirroring the pattern in source-trace-locator.test.ts
 * and PainSignalBridge. Malformed JSON is skipped (not crashed). Missing
 * sourcePainId is skipped (no match).
 *
 * ERR refs:
 *   - ERR-001: parsed JSON treated as unknown
 *   - ERR-005/007: no `as` bypass; type narrowing via typeof + Object.hasOwn
 *   - ERR-013: Object.hasOwn for untrusted key checks
 *   - ERR-009: missing sourcePainId = no match (fail loud, not silent skip)
 */
async function findDreamerTaskForPain(stateManager: RuntimeStateManager, painId: string): Promise<string | null> {
  const tasks = await stateManager.listTasks();
  const dreamerTasks = tasks.filter((t) => t.taskKind === 'dreamer');
  for (const t of dreamerTasks) {
    if (typeof t.diagnosticJson !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t.diagnosticJson);
    } catch {
      // Malformed JSON — skip this task, don't crash (Runtime Contract Rule 9:
      // graceful degradation with observable behavior — the task is simply not
      // a match, and the caller will report no_dreamer_task_seeded_for_pain).
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (!Object.hasOwn(obj, 'sourcePainId')) continue;
    const stored = obj.sourcePainId;
    if (typeof stored === 'string' && stored === painId) {
      return t.taskId;
    }
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

/**
 * Run a single pipeline stage with bounded retry for transient `retried` status.
 *
 * Runtime Contract Rule 7: retry/repair loops must distinguish current, next,
 * and recorded state. Each iteration calls `runner.run(taskId)` fresh — the
 * runner reads from the state manager which has the updated task state
 * (including any `retry_wait` → `pending` transition from the previous
 * iteration). No stale state is carried across iterations.
 *
 * `retried` is NOT terminal — it means the runner hit a transient error and
 * marked the task for retry. The pipeline retries up to `maxStageRetries`
 * times (default 2). When exhausted, the stage is marked 'degraded' with a
 * structured reason, and the caller treats it as a non-success outcome.
 */
interface RunStageOptions {
  readonly maxStageRetries: number;
  readonly pollIntervalMs: number;
}

async function runStage(
  runner: { run(id: string): Promise<PeerRunnerResult<unknown>> },
  taskId: string,
  opts: RunStageOptions,
): Promise<PeerRunnerResult<unknown>> {
  let attempt = 0;
  // First attempt is not a retry — it's the initial run.
  let result = await runner.run(taskId);
  while (result.status === 'retried' && attempt < opts.maxStageRetries) {
    attempt++;
    // Brief wait before retry to allow transient conditions to clear.
    // The state manager has already marked the task as retry_wait; the runner
    // will re-read it on the next .run() call (fresh state per iteration).
    await new Promise<void>((resolve) => setTimeout(resolve, opts.pollIntervalMs));
    result = await runner.run(taskId);
  }
  return result;
}

function stageFromResult(
  name: RuleHostPipelineStage['name'],
  taskId: string,
  result: PeerRunnerResult<unknown>,
): RuleHostPipelineStage {
  // `retried` after exhausting retries is a transient-exhausted state, not a
  // hard failure. Mark as 'degraded' so the caller can distinguish "stage
  // failed permanently" from "stage exhausted transient retries".
  if (result.status === 'succeeded') {
    return { name, taskId, status: 'succeeded' };
  }
  if (result.status === 'retried') {
    return {
      name,
      taskId,
      status: 'degraded',
      reason: `transient_retry_exhausted: ${result.failureReason ?? result.status}`,
    };
  }
  return {
    name,
    taskId,
    status: 'failed',
    reason: result.failureReason ?? result.status,
  };
}

function rejectedResult(painId: string, stages: RuleHostPipelineStage[], degradationReason: string): RuleHostPipelineResult {
  return {
    decision: 'generation_rejected',
    painId,
    stages,
    scribeTaskId: null,
    ruleArtifactId: null,
    principleArtifactId: null,
    degradationReason,
  };
}

/**
 * Build a text-principle-only result when the code-rule capability is OFF.
 *
 * The scribe stage already produced a principle artifact (stored via the
 * artifact store). We look it up by the scribe task ID so the caller can
 * reference it for prompt-channel fallback.
 */
interface TextPrincipleOnlyParams {
  readonly painId: string;
  readonly stages: RuleHostPipelineStage[];
  readonly scribeTaskId: string;
  readonly disabledReason: string;
  readonly artifactStore: PIArtifactStore;
}

async function textPrincipleOnlyResult(
  params: TextPrincipleOnlyParams,
): Promise<RuleHostPipelineResult> {
  const { painId, stages, scribeTaskId, disabledReason, artifactStore } = params;
  // Look up the principle artifact produced by the scribe stage.
  let principleArtifactId: string | null = null;
  try {
    const arts = await artifactStore.listBySourceTaskId(scribeTaskId);
    const principleArt = arts.find((a) => a.artifactKind === 'principle');
    principleArtifactId = principleArt?.artifactId ?? null;
  } catch {
    // Best-effort lookup — if the store query fails, principleArtifactId
    // remains null and the degradationReason explains the situation.
  }

  return {
    decision: 'text_principle_only',
    painId,
    stages,
    scribeTaskId,
    ruleArtifactId: null,
    principleArtifactId,
    degradationReason: `code_rule_capability_off: ${disabledReason}`,
  };
}
