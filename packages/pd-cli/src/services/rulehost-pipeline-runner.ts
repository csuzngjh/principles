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
  parsePITaskMetadata,
  runAdversarialLoop,
  evaluateInRefinerSandbox,
  DEFAULT_MAX_ROUNDS,
  SqliteApprovalQueueStore,
  getChannelRiskLevel,
  // PRI-510: feature-flag resolvers imported from the core barrel (EP-02:
  // pd-config-loader.ts only re-exports loadPdConfig + computeFlagsFromLoadResult;
  // computeFeatureFlagsFromConfig / isFeatureEnabled live in core).
  computeFeatureFlagsFromConfig,
  isFeatureEnabled,
} from '@principles/core/runtime-v2';
import type {
  AdversarialLoopResult,
  PDRuntimeAdapter,
  PeerRunnerResult,
  RefinerRuleHostGateDeps,
  PIArtifactStore,
  ApprovalRecord,
  BehaviorExamplePack,
  // PRI-510: type-only import for the repair-loop deps contract (EP-02 wiring).
  // RuntimeStateManager / StoreEventEmitter are already imported as values
  // above; EvaluatorValidator is type-only.
  EvaluatorRunnerDeps,
  SeedArtificerRepairParams,
  EvaluatorValidator,
} from '@principles/core/runtime-v2';
import { createHash } from 'node:crypto';
import { loadPdConfig } from './pd-config-loader.js';
import { createEvaluatorRuntimeContext } from '@principles/host-runtime';
/* eslint-disable @typescript-eslint/no-use-before-define -- helpers declared after main, matching codebase convention */
import { compileDemoRule } from './demo-rule-compiler.js';

/**
 * Layer 0 content-hash function for the internalization progressive
 * disclosure (design §6.1). Core never imports `node:crypto`, so the plugin/CLI
 * layer injects the algorithm. Consumed only when the
 * `artifact_summary_redundancy` flag is on; harmless otherwise.
 *
 * Exported so other CLI command modules (e.g. `runtime-internalization-run-once`)
 * can reuse the same algorithm without each re-importing `node:crypto`.
 */
export const contentHashFn = (input: string): string => createHash('sha256').update(input).digest('hex');

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

export interface RuleHostAgentAdapters {
  readonly dreamer: PDRuntimeAdapter;
  readonly philosopher: PDRuntimeAdapter;
  readonly scribe: PDRuntimeAdapter;
  readonly evaluator: PDRuntimeAdapter;
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
  /** Production per-agent adapters. Tests may omit this to use runtimeAdapter for every stage. */
  readonly agentAdapters?: RuleHostAgentAdapters;
  /**
   * Code-rule capability (atomic: ArtificerL2 + Evaluator). When omitted, the
   * capability is treated as OFF with reason 'code_rule_capability not provided'.
   */
  readonly codeRuleCapability?: CodeRuleCapability;
  /** Explicit Artificer contract selected by the workspace feature flag. */
  readonly contextMode?: 'v1' | 'v2';
  /** Required in v2 mode; assembled from Owner-labelled production evidence. */
  readonly behaviorExamplePack?: BehaviorExamplePack;
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
  /**
   * Approval ID when the candidate was auto-enqueued into the ApprovalQueue.
   * Present when decision='candidate_ready_for_owner_review' and the pipeline
   * successfully enqueued the candidate for owner review (P1 #1 fix).
   * Null when the candidate was not enqueued (text_principle_only, rejected,
   * or enqueue failed — check degradationReason for details).
   */
  readonly approvalId: string | null;
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
    // Issue 2: load effective config once so every stage runner can resolve
    // feature flags (e.g. `artificer_output_retry`). Mirrors
    // createEvaluatorRunnerDeps (rc-9: malformed config → fallback defaults).
    const configLoad = loadPdConfig(opts.workspaceDir);
    const effectiveConfig = configLoad.ok ? configLoad.effective : configLoad.defaults;
    // Allow the caller's adapter to resolve real artifactIds (needed by
    // test-double adapters whose scripted outputs must match store-assigned IDs).
    opts.onStoreReady?.(artifactStore);
    const owner = 'rulehost-pipeline';
    const agentAdapters = opts.agentAdapters ?? {
      dreamer: opts.runtimeAdapter,
      philosopher: opts.runtimeAdapter,
      scribe: opts.runtimeAdapter,
      evaluator: opts.runtimeAdapter,
    };
    const runnerOptsFor = (adapter: PDRuntimeAdapter) => ({ owner, runtimeKind: adapter.kind(), pollIntervalMs, timeoutMs, effectiveConfig });

    // ── Stage: pain lookup ──
    // Find a dreamer task already seeded for this pain (the pain→dreamer bridge
    // runs via `pd pain record` → PainSignalBridge.onPainDetected). We need the
    // dreamer task to start the chain. If none exists, the operator must run
    // `pd pain record` first — fail loud with guidance.
    //
    // D fix (PRI-429): exact sourcePainId match via Object.hasOwn on parsed
    // diagnosticJson. No substring matching (pain-1 must NOT match pain-10).
    onProgress('pain_lookup', 'start', `painId=${opts.painId}`);
    const dreamerLookup = await findDreamerTaskForPain(stateManager, opts.painId, channel);
    if (dreamerLookup.status === 'ambiguous') {
      const reason = `ambiguous_dreamer_tasks_for_pain: ${dreamerLookup.taskIds.join(',')}`;
      stages.push({ name: 'pain_lookup', status: 'failed', reason });
      onProgress('pain_lookup', 'failed', reason);
      return rejectedResult(opts.painId, stages, reason);
    }
    if (dreamerLookup.status === 'not_found') {
      stages.push({ name: 'pain_lookup', status: 'failed', reason: 'no_dreamer_task_seeded_for_pain' });
      onProgress('pain_lookup', 'failed', 'no dreamer task seeded');
      return rejectedResult(opts.painId, stages, 'no_dreamer_task_seeded_for_pain: run `pd pain record` first');
    }
    const dreamerSeedTaskId = dreamerLookup.taskId;
    stages.push({ name: 'pain_lookup', status: 'succeeded', taskId: dreamerSeedTaskId });
    onProgress('pain_lookup', 'succeeded', `dreamerTaskId=${dreamerSeedTaskId}`);

    // ── Stage: dreamer ──
    onProgress('dreamer', 'start');
    if (dreamerLookup.taskStatus === 'succeeded') {
      stages.push({ name: 'dreamer', taskId: dreamerSeedTaskId, status: 'succeeded' });
    } else {
      const dreamerRunner = new DreamerRunner(
        { stateManager, runtimeAdapter: agentAdapters.dreamer, eventEmitter, validator: new DefaultDreamerValidator(), artifactStore, contentHashFn },
        runnerOptsFor(agentAdapters.dreamer),
      );
      const dreamerResult = await runStage(dreamerRunner, dreamerSeedTaskId, { maxStageRetries, pollIntervalMs });
      stages.push(stageFromResult('dreamer', dreamerSeedTaskId, dreamerResult));
      if (dreamerResult.status !== 'succeeded') {
        onProgress('dreamer', 'failed', dreamerResult.failureReason);
        return rejectedResult(opts.painId, stages, `dreamer_failed: ${dreamerResult.failureReason ?? dreamerResult.status}`);
      }
    }
    onProgress('dreamer', 'succeeded');

    // ── Stage: philosopher ──
    onProgress('philosopher', 'start');
    const philosopherTaskId = `${correlation}-philosopher-${Date.now().toString(36)}`;
    await createInternalizationTask(stateManager, philosopherTaskId, 'philosopher', [dreamerSeedTaskId], channel, timeoutMs);
    const philosopherRunner = new PhilosopherRunner(
      { stateManager, runtimeAdapter: agentAdapters.philosopher, eventEmitter, validator: new DefaultPhilosopherValidator(), artifactStore, contentHashFn },
      runnerOptsFor(agentAdapters.philosopher),
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
      { stateManager, runtimeAdapter: agentAdapters.scribe, eventEmitter, validator: new DefaultScribeValidator(), artifactStore, contentHashFn },
      runnerOptsFor(agentAdapters.scribe),
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
    // PRI-661: the loop's evaluator replay must use the SAME production gate
    // context as the consumer cycle and the activation gate (workspace root +
    // durable host tool registry). The previous sandbox-only gateDeps could
    // pass generation-time replay and fail the production activation gate on
    // the same workspace — the drift class PRI-634-F closed elsewhere.
    // Unresolvable provenance fails the loop LOUD (never a silent baseline
    // fallback — ERR-114), mirroring the artificerAdapter-not-provided failure
    // precedent below.
    const evaluatorContext = createEvaluatorRuntimeContext({ workspaceDir: opts.workspaceDir });
    if (!evaluatorContext.ok) {
      const refusalReason = `${evaluatorContext.reason} — ${evaluatorContext.nextAction}`;
      stages.push({ name: 'adversarial_loop', status: 'failed', reason: refusalReason });
      onProgress('adversarial_loop', 'failed', refusalReason);
      return rejectedResult(opts.painId, stages, `evaluator_runtime_context_unresolvable: ${evaluatorContext.reason} (nextAction: ${evaluatorContext.nextAction})`);
    }
    const artificerRunner = new ArtificerRunner(
      {
        stateManager, runtimeAdapter: capability.artificerAdapter, eventEmitter, validator: new DefaultArtificerValidator(), artifactStore,
        contextMode: opts.contextMode ?? 'v1', behaviorExamplePack: opts.behaviorExamplePack, contentHashFn,
      },
      runnerOptsFor(capability.artificerAdapter),
    );
    // PRI-510 (DEFECT-004): construct EvaluatorRunnerDeps via the centralized
    // helper so the repair-loop wiring (isRepairLoopEnabled + seeder) is
    // actually invoked in the production CLI path. EP-02: prior code passed
    // only the 5 base deps, leaving the repair loop as dead code at runtime.
    const evaluatorRunner = new EvaluatorRunner(
      createEvaluatorRunnerDeps({
        stateManager,
        runtimeAdapter: agentAdapters.evaluator,
        eventEmitter,
        validator: new DefaultEvaluatorValidator(),
        artifactStore,
        workspaceDir: opts.workspaceDir,
      }),
      // PRI-661: production gate context (workspace root + host tool registry
      // from durable provenance) — replaces the previous sandbox-only gate
      // deps so generation-time replay verdicts match the activation gate on
      // the same workspace. Options argument (2nd), never deps (1st).
      { ...runnerOptsFor(agentAdapters.evaluator), gateDeps: evaluatorContext.gateDeps },
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

    // P1 #1 fix: auto-enqueue the candidate into the ApprovalQueue so the
    // owner can review it. Without this, the pipeline produces a candidate
    // artifact but it never enters the approval queue — the production chain
    // is broken at step 2→3. Tests manually called enqueue(); production did not.
    let approvalId: string | null = null;
    if (pipelineDecision === 'candidate_ready_for_owner_review' && loopResult.ruleArtifactId) {
      try {
        const approvalStore = new SqliteApprovalQueueStore(stateManager.connection);
        const riskLevel = getChannelRiskLevel(channel);
        const enqueuedRecord: ApprovalRecord = await approvalStore.enqueue({
          artifactId: loopResult.ruleArtifactId,
          channel,
          riskLevel,
          summary: `RuleHost pipeline candidate for pain ${opts.painId}`,
          triggerReason: `adversarial_loop_approved: pain=${opts.painId}, rule=${loopResult.ruleArtifactId}`,
        }, new Date().toISOString());
        const { approvalId: enqueuedApprovalId } = enqueuedRecord;
        approvalId = enqueuedApprovalId;
        onProgress('adversarial_loop', 'succeeded', `auto-enqueued as approval ${approvalId}`);
      } catch (err: unknown) {
        // Enqueue failed — the candidate artifact exists but is not in the
        // approval queue. Degrade gracefully with a structured reason (ERR-002).
        const enqueueErr = err instanceof Error ? err.message : String(err);
        const degradeReason = `candidate_approved_but_enqueue_failed: ${enqueueErr}. Manual enqueue required: pd activation dispatch --artifact-id ${loopResult.ruleArtifactId} --channel ${channel}`;
        return {
          decision: pipelineDecision,
          painId: opts.painId,
          stages,
          scribeTaskId,
          adversarialLoop: loopResult,
          ruleArtifactId: loopResult.ruleArtifactId,
          principleArtifactId: loopResult.principleArtifactId,
          approvalId: null,
          degradationReason: degradeReason,
        };
      }
    }

    return {
      decision: pipelineDecision,
      painId: opts.painId,
      stages,
      scribeTaskId,
      adversarialLoop: loopResult,
      ruleArtifactId: loopResult.ruleArtifactId,
      principleArtifactId: loopResult.principleArtifactId,
      approvalId,
      degradationReason: loopResult.degradationReason,
    };
  } finally {
    await stateManager.close();
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
type DreamerTaskLookup =
  | { readonly status: 'found'; readonly taskId: string; readonly taskStatus: 'pending' | 'retry_wait' | 'succeeded' }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous'; readonly taskIds: readonly string[] };

async function findDreamerTaskForPain(
  stateManager: RuntimeStateManager,
  painId: string,
  channel: 'prompt' | 'code_tool_hook' | 'defer_archive',
): Promise<DreamerTaskLookup> {
  const tasks = await stateManager.listTasks();
  const dreamerTasks = tasks.filter((t) =>
    t.taskKind === 'dreamer' && (t.status === 'pending' || t.status === 'retry_wait' || t.status === 'succeeded'),
  );
  const allMatches: typeof dreamerTasks = [];
  const channelMatches: typeof dreamerTasks = [];
  for (const t of dreamerTasks) {
    if (typeof t.diagnosticJson !== 'string') continue;
    const metadata = parsePITaskMetadata(t.diagnosticJson);
    if (!metadata) continue;
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
    if (!Object.hasOwn(parsed, 'sourcePainId')) continue;
    const stored = Reflect.get(parsed, 'sourcePainId');
    if (typeof stored === 'string' && stored === painId) {
      allMatches.push(t);
      if (metadata.channel === channel) channelMatches.push(t);
    }
  }
  const matches = channelMatches.length > 0 ? channelMatches : allMatches;
  matches.sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (matches.length === 0) return { status: 'not_found' };
  if (matches.length > 1) return { status: 'ambiguous', taskIds: matches.map((task) => task.taskId) };
  const [match] = matches;
  if (!match || (match.status !== 'pending' && match.status !== 'retry_wait' && match.status !== 'succeeded')) {
    return { status: 'not_found' };
  }
  return { status: 'found', taskId: match.taskId, taskStatus: match.status };
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

// ── PRI-510 (DEFECT-004): EvaluatorRunner repair-loop CLI wiring ────────────
//
// EP-02 (Production Path Wiring): PRI-509 added the `isRepairLoopEnabled` and
// `seedArtificerRepairTask` deps to `EvaluatorRunnerDeps` (core), but the two
// CLI production paths (runtime-internalization-run-once.ts and this file)
// constructed `EvaluatorRunner` with only the base deps — the repair loop was
// dead code at runtime (evaluator needs_revision seeded nothing).
//
// This helper centralizes the construction of the full deps so both CLI sites
// stay in sync. The flag resolver reads `.pd/config.yaml` (the unified config
// — ADR-0016); the seeder writes the repair task via `stateManager.createTask`
// (the only sanctioned task-creation path; core peer runners are forbidden
// from calling it directly — architecture-regression.test.ts enforces this).

/**
 * Inputs for {@link createEvaluatorRunnerDeps}. Carries the base `PeerRunnerDeps`
 * fields plus `workspaceDir` (used to resolve the feature flag from
 * `.pd/config.yaml`).
 */
export interface CreateEvaluatorRunnerDepsInputs {
  readonly stateManager: RuntimeStateManager;
  readonly runtimeAdapter: PDRuntimeAdapter;
  readonly eventEmitter: StoreEventEmitter;
  readonly validator: EvaluatorValidator;
  readonly artifactStore: PIArtifactStore;
  /** Workspace directory containing `.pd/config.yaml` (flag source). */
  readonly workspaceDir: string;
  /**
   * Layer 0 content-hash function (design §6.1). Optional — defaults to the
   * module-level sha256-hex `contentHashFn`. Allow override for tests.
   */
  readonly contentHashFn?: (input: string) => string;
}

/**
 * Build the full `EvaluatorRunnerDeps` for CLI production paths, including the
 * PRI-509 repair-loop wiring (EP-02: production path must invoke core logic).
 *
 * - `isRepairLoopEnabled`: reads `.pd/config.yaml` and resolves the
 *   `evaluator_artificer_repair_loop` flag. Defaults to false when the config
 *   is missing or malformed (rc-9: fail safe — legacy path runs, never throws).
 * - `seedArtificerRepairTask`: creates a new `artificer` task carrying the
 *   `repairPayload` in `diagnosticJson` (rc-1, rc-6: serialized via the
 *   validated `createPITaskDiagnosticJson`, no `as` bypass). Reuses the
 *   artificer runner (PRI-509 D1) rather than introducing a new task kind.
 *
 * Returns the newly created repair task's ID (UUIDv4, rc-7: fresh per call).
 */
export function createEvaluatorRunnerDeps(inputs: CreateEvaluatorRunnerDepsInputs): EvaluatorRunnerDeps {
  const { stateManager, runtimeAdapter, eventEmitter, validator, artifactStore, workspaceDir } = inputs;
  return {
    stateManager,
    runtimeAdapter,
    eventEmitter,
    validator,
    artifactStore,
    // Layer 0 (design §6.1): inject the content-hash function so the evaluator
    // writer can attach a `predecessorSummary.contentHash` for staleness
    // detection. Defaults to the module-level sha256-hex constant.
    contentHashFn: inputs.contentHashFn ?? contentHashFn,
    isRepairLoopEnabled: (): boolean => {
      // rc-9: never throw on malformed config — fail safe to false so the
      // legacy (non-repair) path runs. The malformed config is already
      // surfaced by `pd config doctor` and CLI start-up warnings.
      try {
        const result = loadPdConfig(workspaceDir);
        const effective = result.ok ? result.effective : result.defaults;
        const flags = computeFeatureFlagsFromConfig(effective);
        return isFeatureEnabled(flags, 'evaluator_artificer_repair_loop');
      } catch {
        return false;
      }
    },
    seedArtificerRepairTask: async (params: SeedArtificerRepairParams): Promise<string> => {
      // rc-7: each call gets a fresh task ID — never reuse a cached ID.
      // P0-4: deterministic revision identity + reuse on replay
      const repairTaskId = `artificer-repair-${params.repairPayload.sourceEvaluatorTaskId}-r${params.repairPayload.repairIteration}`;
      const existing = await stateManager.getTask(repairTaskId);
      if (existing) return repairTaskId;
      await stateManager.createTask({
        taskId: repairTaskId,
        // D1 (PRI-509): task kind is 'artificer' — reuses the artificer
        // runner, which detects repairPayload in diagnosticJson and
        // forwards it to the prompt builder as repairFeedback.
        taskKind: 'artificer',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        // rc-1, rc-6: serialize via the validated helper — repairPayload
        // is untrusted LLM output but `createPITaskDiagnosticJson` writes
        // it through `serializePITaskMetadata`, which `parsePITaskMetadata`
        // re-validates on read (defense in depth).
        diagnosticJson: createPITaskDiagnosticJson({
          // PITaskMetadata fields are mutable arrays (the metadata envelope
          // serializes them as JSON arrays). The SeedArtificerRepairParams
          // contract carries readonly arrays (rc-1: untrusted input from the
          // evaluator LLM). Spread to a fresh mutable array — no mutation of
          // the caller's data.
          dependencyTaskIds: [...params.inheritedDependencyTaskIds],
          channel: params.inheritedChannel,
          timeoutMs: params.inheritedTimeoutMs,
          inputArtifactRefs: [...params.inheritedInputArtifactRefs],
          outputArtifactRefs: [],
          repairPayload: params.repairPayload,
        }),
      });
      return repairTaskId;
    },
  };
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
    approvalId: null,
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
  try {
    const arts = await artifactStore.listBySourceTaskId(scribeTaskId);
    const principleArt = arts.find((a) => a.artifactKind === 'principle');
    return {
      decision: 'text_principle_only',
      painId,
      stages,
      scribeTaskId,
      ruleArtifactId: null,
      principleArtifactId: principleArt?.artifactId ?? null,
      approvalId: null,
      degradationReason: `code_rule_capability_off: ${disabledReason}`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      decision: 'text_principle_only',
      painId,
      stages,
      scribeTaskId,
      ruleArtifactId: null,
      principleArtifactId: null,
      approvalId: null,
      degradationReason: `code_rule_capability_off: ${disabledReason}; principle_artifact_lookup_failed: ${message}`,
    };
  }

}
