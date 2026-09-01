/**
 * EvaluatorRunner — Peer runner for principle evaluation (PRI-67).
 *
 * Migrated to extend BasePeerRunner (PRI-302). The shared lease → buildContext →
 * invoke → poll → fetch → validate → succeed/fail pipeline is now in the base
 * class. This file only contains Evaluator-specific logic.
 *
 * Key business semantics:
 *   - Evaluator approved → must validate the principle-bearing Scribe artifact,
 *     NOT the Artificer plan artifact. This is the critical lineage contract.
 *   - resolvePrincipleBearerArtifact uses sourceTrace.scribeArtifactId first,
 *     then falls back to lineage search. Ambiguous candidates → fail loud.
 *   - updateValidationStatus returning false → structured telemetry, no silent skip.
 *
 * ERR considerations:
 *   - ERR-001 / ERR-005: output is `unknown` until validateOutput passes.
 *   - ERR-004 / ERR-008: sourceTrace / scribeArtifactId / sourceArtificerArtifactId
 *     must be internally consistent.
 *   - ERR-018 / ERR-019: validationStatus update target must be the correct
 *     principle-bearing artifact, never stale or wrong.
 *   - ERR-025: tests must exercise real evaluator runner path.
 *   - ERR-048: activation write/read path must not break.
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 * @see BasePeerRunner in runner/base-peer-runner.ts
 */
import type { RunHandle, RunStatus } from '../runtime-protocol.js';
import type {
  EvaluatorOutputV1,
  EvaluatorOutputV2,
  EvaluatorValidator,
  EvaluatorAdversarialResult,
  AdversarialFailedCase,
  AdversarialCase,
} from './evaluator-output.js';
import { isEvaluatorOutputV2 } from './evaluator-output.js';
// PRI-634 A2 (authority migration): gate necessity derives from the durable
// Artificer artifact, not from optional LLM output shape.
import { assessArtificerCodeBearing } from './artificer-code-bearing.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory, isPDErrorCategory } from '../error-categories.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata, type RepairPayload, type PITaskMetadata, type RunnerDecision, type HumanReviewContext } from './pitask-metadata.js';
import {
  HUMAN_REVIEW_REASON,
  planOwnerVerdictOverrideResume,
  markOwnerResolutionApplied,
  computeArtifactContentHash,
  type OwnerOverrideResumePlan,
} from './owner-review.js';
import { EvaluatorPromptBuilder, deriveRequirementLedger, type PreviousEvaluationContext, type HostToolCatalogFacts } from './evaluator-prompt-builder.js';
import { reconcileLineageEcho, type InternalizationChannel, type ArtifactRef } from './peer-runner-contracts.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import type {
  PeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../runner/peer-runner-types.js';
import type { LoadedPredecessorArtifact } from './attach-summary-envelope.js';
import { EVALUATOR_STAGE1_MANIFEST, EVALUATOR_STAGE2_MANIFEST } from './context-manifests.js';
import { evaluateFlaggedCriteria, isForcedStage2 } from './progressive-evaluator.js';
// PRI-426: single-round adversarial sandbox replay in succeedTask.
import { evaluateRefinerRuleHostGate, type RefinerRuleHostGateDeps } from './refiner-rulehost-gate.js';
import { adversarialCasesToGoldenTrace } from './adversarial-case.js';
import { buildGoldenTraceFromArtificer } from '../golden-trace.js';
import type { GoldenTrace, GoldenTraceCase } from '../golden-trace.js';
// PRI-485 Phase 6: auto-generate 5 v2 adversarial cases (unavailable/truncation/
// alias/path/combination) to defend against false-positive blocks.
import { generateV2ContextAdversarialCases } from './v2-adversarial-cases.js';
import { canonicalizeToolKind } from './rule-context-v2.js';

// ── Evaluator-specific context ────────────────────────────────────────────────

/** Context built by EvaluatorRunner.buildContext() and consumed by invokeRuntime(). */
interface EvaluatorContext {
  readonly contextHash: string;
  readonly artificerArtifact: string | null;
  readonly sourceArtificerArtifactId: string | null;
  /**
   * Scribe principle artifact contentJson (RuleHost MVP Activation, PRD Decision 12).
   * Loaded so the evaluator LLM can judge code intentConsistency/scopePrecision
   * against the original principle text. Null when no scribe artifact is resolvable
   * (scribeArtifactId missing/malformed or upstream artifact unavailable).
   */
  readonly scribeArtifact: string | null;
  readonly sourceScribeArtifactId: string | null;
  /**
   * PRI-630 收敛契约: 依赖 artificer 的 repairPayload (第 2+ 轮存在)。
   * 派生 previousEvaluation 注入 prompt — 上轮 decision/score/concerns/
   * requiredChanges(稳定 id)/repairIteration。
   */
  readonly dependencyRepairPayload?: RepairPayload;
  /** PRI-630: 由 dependencyRepairPayload 解析的上轮评估上下文 (首轮 undefined) */
  readonly previousEvaluation?: PreviousEvaluationContext;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * PRI-634: resolve a golden-trace case's target path across the host tool
 * schemas actually observed on real chains.
 *
 * Golden-trace params are echoed verbatim from the host trajectory
 * (behavior-example-pack-assembler `params: parsedParams`), so the field name
 * follows whatever the host tool used — the dominant write-tool schema spells
 * it `file_path` (OpenClaw / Claude Code), while PRI-485's v2 generator only
 * read `path`. Reading a single spelling made v2 auto-generation structurally
 * unreachable: the merged adversarial set stayed empty, the deterministic gate
 * never ran, and an LLM-declared `adversarialResult.passed = true` silently
 * stood in for a real replay (chain 48371236).
 *
 * Returns null when neither spelling yields a non-empty string.
 */
function resolveCasePathParam(params: unknown): string | null {
  if (!isRecordValue(params)) return null;
  for (const key of ['path', 'file_path']) {
    const raw = params[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw;
  }
  return null;
}

/**
 * P0-B (verdict drift 完整性): rule assembly 的稳定输入。fresh 路径来自
 * buildContext 的内存结果;resume 路径从 durable lineage 重建 (store 按
 * output.sourceArtificerArtifactId 取 contentJson) — 瞬时内存 context 不得
 * 作为 recovery authority。
 */
interface RuleAssemblyInput {
  readonly artificerArtifact: string | null;
  readonly sourceArtificerArtifactId: string | null;
}

/**
 * Extract scribeArtifactId from an artificer artifact's contentJson (PRD Decision 12).
 * The contentJson is untrusted — parsed defensively with type guards, never as-cast
 * (Runtime Contract Rule 1/2/5). Returns null when the field is absent or malformed;
 * callers treat null as "code review degraded (no principle text)".
 *
 * Looks in two locations:
 *   1. top-level sourceTrace.scribeArtifactId (ArtificerRuleOutput contract)
 *   2. top-level sourceScribeArtifactId (ArtificerRuleOutput contract)
 */
function extractScribeArtifactId(artificerContentJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(artificerContentJson);
  } catch {
    return null;
  }
  if (!isRecordValue(parsed)) return null;

  // sourceTrace.scribeArtifactId
  const trace = Object.hasOwn(parsed, 'sourceTrace') ? parsed.sourceTrace : undefined;
  if (isRecordValue(trace)) {
    const fromTrace = Object.hasOwn(trace, 'scribeArtifactId') ? trace.scribeArtifactId : undefined;
    if (typeof fromTrace === 'string' && fromTrace.trim() !== '') return fromTrace;
  }
  // top-level sourceScribeArtifactId
  const direct = Object.hasOwn(parsed, 'sourceScribeArtifactId') ? parsed.sourceScribeArtifactId : undefined;
  if (typeof direct === 'string' && direct.trim() !== '') return direct;

  return null;
}


/**
 * Layer 0 (design §6.1, F17): evaluator's edge predecessor is `artificer` —
 * NOT scribe, even though buildContext loads both. The scribe artifact is
 * still consumed by invokeRuntime for code-review intent consistency; only the
 * artificer goes into `predecessorSummary`. Reusing the already-loaded string
 * keeps the writer path at zero extra store reads (F3). Returns null when no
 * artificer artifact was resolved — the writer then emits
 * `artifact_summary_predecessor_absent` and writes only the self `summary`.
 */
function toArtificerPredecessor(context: EvaluatorContext): LoadedPredecessorArtifact | null {
  if (!context.artificerArtifact || !context.sourceArtificerArtifactId) return null;
  let contentJson: unknown;
  try {
    contentJson = JSON.parse(context.artificerArtifact);
  } catch {
    contentJson = context.artificerArtifact;
  }
  return {
    artifactId: context.sourceArtificerArtifactId,
    runnerKind: 'artificer',
    contentJson,
  };
}

/**
 * Check Stage 1 output for contract violations (design §6.5.4, Req 7.18).
 * Returns a reason string when the output is malformed, or null when valid.
 * Covers the failure modes observed in Phase 0 testing:
 *   - non-object (null, string, array)
 *   - missing `evaluation` sub-object (the core evaluator output structure)
 *   - `evaluation.decision` absent or not a string
 */
function checkStage1ContractOutput(output: unknown): string | null {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return 'output_not_object';
  }
  const rec = output as Record<string, unknown>;
  if (!Object.hasOwn(rec, 'evaluation') || rec.evaluation === null || typeof rec.evaluation !== 'object' || Array.isArray(rec.evaluation)) {
    return 'evaluation_missing';
  }
  const ev = rec.evaluation as Record<string, unknown>;
  if (!Object.hasOwn(ev, 'decision') || typeof ev.decision !== 'string') {
    return 'decision_missing';
  }
  return null;
}


// ── Result Types (backward-compatible exports) ────────────────────────────────

export type EvaluatorRunnerResultStatus = 'succeeded' | 'failed' | 'retried';

export interface EvaluatorRunnerResult {
  readonly status: EvaluatorRunnerResultStatus;
  readonly taskId: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly resultRef?: string;
  readonly contextHash?: string;
  readonly output?: EvaluatorOutputV1;
  readonly errorCategory?: PDErrorCategory;
  readonly failureReason?: string;
  readonly attemptCount: number;
}

// ── Constructor Options (backward-compatible exports) ─────────────────────────

/**
 * EvaluatorRunner options. Extends PeerRunnerOptions with an optional
 * RuleHost sandbox gate deps (PRI-426). When `gateDeps` is provided AND the
 * evaluator output is V2 (code-bearing), succeedTask runs a single-round
 * adversarial sandbox replay and populates `adversarialResult`.
 *
 * When `gateDeps` is absent, V2 outputs still validate but no replay runs —
 * this preserves backward compatibility for callers not yet wired to the
 * sandbox (e.g. V1-only test fixtures, pre-Phase-6 assembly).
 */
export interface EvaluatorRunnerOptions extends PeerRunnerOptions {
  readonly gateDeps?: RefinerRuleHostGateDeps;
  /**
   * PRI-630 工具目录权威: runtime-authoritative host tool facts (readOnly /
   * write 工具名)。由宿主装配层注入;缺失时 prompt 声明 degraded 规则 —
   * 工具名差异不得成为 hard blocker。
   */
  readonly hostToolCatalog?: HostToolCatalogFacts;
}

export interface ResolvedEvaluatorRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
}

export const DEFAULT_EVALUATOR_RUNNER_OPTIONS: Readonly<Omit<ResolvedEvaluatorRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'evaluator',
} as const;

export function resolveEvaluatorRunnerOptions(options: EvaluatorRunnerOptions): ResolvedEvaluatorRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_EVALUATOR_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_EVALUATOR_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_EVALUATOR_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? DEFAULT_EVALUATOR_RUNNER_OPTIONS.agentId,
  };
}

// ── Dependencies (backward-compatible; extends PeerRunnerDeps) ────────────────

/**
 * PRI-509: Parameters for seeding an artificer repair task.
 *
 * The evaluator runner constructs the repairPayload (core logic — 6 fields
 * sourced from the current evaluator output) and resolves inherited lineage
 * from the dependency artificer task. The actual task record creation is
 * delegated to the plugin layer via `seedArtificerRepairTask` to preserve
 * the core/plugin boundary (core peer runners do NOT directly orchestrate
 * task creation — enforced by architecture-regression.test.ts).
 */
export interface SeedArtificerRepairParams {
  /** The repair payload (6 fields) constructed by the evaluator runner. */
  readonly repairPayload: RepairPayload;
  /** Scribe task IDs inherited from the original artificer task. */
  readonly inheritedDependencyTaskIds: readonly string[];
  /** Channel inherited from the original artificer task. */
  readonly inheritedChannel: InternalizationChannel;
  /** Timeout inherited from the original artificer task. */
  readonly inheritedTimeoutMs: number;
  /** Input artifact refs inherited from the original artificer task. */
  readonly inheritedInputArtifactRefs: readonly ArtifactRef[];
}

export interface EvaluatorRunnerDeps extends PeerRunnerDeps {
  readonly validator: EvaluatorValidator;
  /**
   * PRI-509: feature flag resolver for the evaluator→artificer repair loop.
   * When omitted or returns false, evaluator needs_revision follows the
   * legacy path (no repair task seeded). When returns true and the
   * decision is needs_revision, the evaluator seeds an artificer repair
   * task (up to 2 rounds) or marks the task needs_human_review on the
   * 3rd round (fail loud, EP-03).
   *
   * Injected by the plugin layer (which reads EffectivePdConfig); core
   * stays pure logic with no direct config coupling (D5).
   */
  readonly isRepairLoopEnabled?: () => boolean;
  /**
   * PRI-509: Seeder function for artificer repair tasks.
   *
   * The plugin layer implements this by serializing the repairPayload +
   * inherited metadata into diagnosticJson and calling stateManager
   * task-creation. Core peer runners must NOT call task-creation directly
   * (architecture-regression.test.ts enforces this boundary).
   *
   * Returns the newly created repair task's ID.
   */
  readonly seedArtificerRepairTask?: (params: SeedArtificerRepairParams) => Promise<string>;
}

// ── EvaluatorRunner ───────────────────────────────────────────────────────────

export class EvaluatorRunner extends BasePeerRunner<EvaluatorContext, EvaluatorOutputV1> {
  private readonly validator: EvaluatorValidator;
  /**
   * Optional RuleHost sandbox gate deps (PRI-426). When present and the output
   * is V2, succeedTask runs a single adversarial sandbox replay. Absent = no
   * replay (backward compatible).
   */
  private readonly gateDeps: RefinerRuleHostGateDeps | null;
  /**
   * PRI-509: feature flag resolver for the evaluator→artificer repair loop.
   * Null when the deps did not inject the resolver (= disabled, legacy path).
   */
  private readonly repairLoopEnabledResolver: (() => boolean) | null;
  /**
   * PRI-509: seeder function for artificer repair tasks.
   * Null when the deps did not inject the seeder (= repair seeding unavailable).
   */
  private readonly repairTaskSeeder: ((params: SeedArtificerRepairParams) => Promise<string>) | null;
  /** PRI-630: runtime-authoritative tool facts; null = catalog unavailable (degraded rule in prompt) */
  private readonly hostToolCatalog: HostToolCatalogFacts | null;

  constructor(deps: EvaluatorRunnerDeps, options: EvaluatorRunnerOptions) {
    super(deps, options, {
      runnerName: 'evaluator',
      expectedTaskKind: 'evaluator',
      defaultAgentId: 'evaluator',
      resultRefPrefix: 'evaluator',
    });
    this.validator = deps.validator;
    this.gateDeps = options.gateDeps ?? null;
    this.repairLoopEnabledResolver = deps.isRepairLoopEnabled ?? null;
    this.repairTaskSeeder = deps.seedArtificerRepairTask ?? null;
    this.hostToolCatalog = options.hostToolCatalog ?? null;
  }

  /**
   * Returns true iff the evaluator→artificer repair loop feature flag is on.
   */
  private isRepairLoopEnabled(): boolean {
    return this.repairLoopEnabledResolver !== null && this.repairLoopEnabledResolver() === true;
  }

  // ── Abstract implementations ────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid']);
  }

  async buildContext(taskId: string): Promise<EvaluatorContext> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    if (deps.length === 0) {
      this.emitEvent('no_dependencies', taskId, {});
      throw new PDRuntimeError('input_invalid', 'Artificer dependency artifact ID not resolved');
    }

    for (const depId of deps) {
      const depTask = await this.stateManager.getTask(depId);
      if (!depTask) continue;
      if (depTask.taskKind !== 'artificer') continue;
      if (depTask.status !== 'succeeded') {
        this.emitEvent('dependency_not_succeeded', taskId, {
          depTaskId: depId,
          depStatus: depTask.status,
        });
        continue;
      }

      const depPi = hydratePITaskRecord(depTask);
      const dependencyRepairPayload = depPi?.repairPayload;
      const artifacts = await this.artifactStore.listBySourceTaskId(depId);
      if (artifacts.length > 0) {
        const [firstArtifact] = artifacts;
        if (!firstArtifact) continue;
        const artifactRef = firstArtifact.artifactId;
        this.emitEvent('artificer_dep_selected', taskId, {
          depTaskId: depId,
          artifactId: firstArtifact.artifactId,
        });

        // PRD Decision 12: resolve the scribe artifact so the evaluator LLM can
        // judge code intentConsistency/scopePrecision against the principle text.
        // Extract scribeArtifactId from the artificer's sourceTrace (untrusted
        // contentJson — validated via type guards, never as-cast; Runtime Rule 1/2).
        const scribeRef = extractScribeArtifactId(firstArtifact.contentJson);
        let scribeContent: string | null = null;
        if (scribeRef) {
          const scribeArtifact = await this.artifactStore.getArtifactById(scribeRef);
          if (scribeArtifact && scribeArtifact.artifactKind === 'principle') {
            scribeContent = scribeArtifact.contentJson;
          } else {
            this.emitEvent('scribe_artifact_unresolvable', taskId, {
              scribeArtifactId: scribeRef,
              reason: scribeArtifact ? `wrong kind: ${scribeArtifact.artifactKind}` : 'not found',
              nextAction: 'code_review_degraded_without_principle_text',
            });
          }
        }

        const contextRefs: string[] = scribeContent && scribeRef
          ? [artifactRef, scribeRef]
          : [artifactRef];
        // PRI-630: 修复轮 (repairPayload 存在) 时解析上轮评估上下文
        let previousEvaluation: PreviousEvaluationContext | undefined;
        if (dependencyRepairPayload) {
          previousEvaluation = await this.resolvePreviousEvaluation(
            taskId, dependencyRepairPayload, firstArtifact.contentJson,
          );
        }
        return {
          contextHash: BasePeerRunner.hashContextRefs(contextRefs),
          artificerArtifact: firstArtifact.contentJson,
          sourceArtificerArtifactId: firstArtifact.artifactId,
          scribeArtifact: scribeContent,
          sourceScribeArtifactId: scribeRef,
          ...(dependencyRepairPayload !== undefined ? { dependencyRepairPayload } : {}),
          ...(previousEvaluation !== undefined ? { previousEvaluation } : {}),
        };
      }
    }

    this.emitEvent('no_artificer_artifact', taskId, {});
    throw new PDRuntimeError('input_invalid', 'Artificer dependency artifact not found');
  }

  /** Synthetic RunHandle prefix for progressive-evaluator pre-resolved output. */
  static readonly PROGRESSIVE_RUN_ID_PREFIX = '__progressive_evaluator_';
  private progressiveFinalOutput: unknown = undefined;
  private progressiveRunActive = false;

  async invokeRuntime(taskId: string, context: EvaluatorContext): Promise<RunHandle> {
    // Layer 2 (design §6.5, task 9.11): when progressive_evaluator flag is on,
    // run two-stage evaluation (Stage 1 summary → flagged? → Stage 2 tier2).
    // When off, the existing single-stage path runs unchanged.
    if (!this.isProgressiveEvaluatorEnabled()) {
      return this.invokeRuntimeSingleStage(taskId, context);
    }

    // ── Two-stage progressive evaluation ──
    // Stage 1: summary-level evaluation (same prompt as single-stage, but
    // uses EVALUATOR_STAGE1_MANIFEST for focused context).
    const stage1Message = this.buildEvaluatorPrompt(taskId, context, EVALUATOR_STAGE1_MANIFEST);
    const stage1Output = await this.runSingleEvaluation(taskId, stage1Message);

    // 9.4c (design §6.5.4): Stage 1 output contract violation check.
    // Detect malformed Stage 1 output shapes that Phase 0 testing identified:
    // non-object, missing required evaluator fields, or the output being a
    // string (markdown-fenced / truncated). In all cases, emit a structured
    // degradation event and force Stage 2 (rc-3 + rc-9: never silently pass).
    //
    // NOTE (Req 7.18): The full attemptStructuredOutputRepair channel is not
    // wired here because it requires an llmCaller callback that connects to
    // runtimeAdapter's internal LLM invocation path — a complex integration
    // deferred to a follow-up PR. This simplified check covers the detected
    // failure modes (non-object, missing evaluation field) and ensures they
    // are never silently treated as "pass".
    const stage1ContractViolated = checkStage1ContractOutput(stage1Output);
    if (stage1ContractViolated !== null) {
      this.emitEvent('stage1_output_contract_violation', taskId, {
        reason: stage1ContractViolated,
        detail: `Stage 1 output contract violated (${stage1ContractViolated}) — forcing Stage 2.`,
      });
    }

    // Evaluate flagged criteria on Stage 1 output.
    // When contract is violated, ALL criteria fields are undetermined → forces Stage 2.
    const d1 = stage1ContractViolated !== null
      ? { flagged: false, reasons: [] as const, undetermined: ['stage1_output_contract_violation'] }
      : evaluateFlaggedCriteria(stage1Output);
    const forced = isForcedStage2(taskId);

    if (!d1.flagged && !forced && d1.undetermined.length === 0) {
      // Stage 1 is sufficient — return its output as the final result.
      this.progressiveFinalOutput = stage1Output;
      this.progressiveRunActive = true;
      return { runId: `${EvaluatorRunner.PROGRESSIVE_RUN_ID_PREFIX}stage1`, runtimeKind: this.getRuntimeKind(), startedAt: new Date().toISOString() };
    }

    // Stage 2 triggered: independent re-evaluation with tier2 context.
    // rc-7 / ERR-015 / ERR-018 / ERR-019: Stage 2 does NOT receive Stage 1
    // output, concerns, or the FlaggedDecision. It is a fully independent call.
    const stage2Message = this.buildEvaluatorPrompt(taskId, context, EVALUATOR_STAGE2_MANIFEST);
    const stage2Output = await this.runSingleEvaluation(taskId, stage2Message);

    this.progressiveFinalOutput = stage2Output;
    this.progressiveRunActive = true;
    return { runId: `${EvaluatorRunner.PROGRESSIVE_RUN_ID_PREFIX}stage2`, runtimeKind: this.getRuntimeKind(), startedAt: new Date().toISOString() };
  }

  /**
   * Override pollUntilTerminal: for synthetic progressive-evaluator RunHandles,
   * the LLM call already completed inside invokeRuntime — return succeeded
   * immediately without hitting the real runtime adapter (which would fail on
   * the synthetic runId). For normal handles, delegate to the base class.
   */
  protected override async pollUntilTerminal(runHandle: RunHandle): Promise<RunStatus> {
    if (this.progressiveRunActive && runHandle.runId.startsWith(EvaluatorRunner.PROGRESSIVE_RUN_ID_PREFIX)) {
      return { status: 'succeeded', runId: runHandle.runId };
    }
    return super.pollUntilTerminal(runHandle);
  }

  /**
   * Intercept fetchAndParseOutput for progressive-evaluator runs: when the
   * runId is a synthetic progressive handle, return the pre-resolved output
   * directly (the actual LLM call already happened inside invokeRuntime).
   */
  protected override async fetchAndParseOutput(runId: string, taskId: string): Promise<unknown> {
    if (this.progressiveRunActive && runId.startsWith(EvaluatorRunner.PROGRESSIVE_RUN_ID_PREFIX)) {
      return this.progressiveFinalOutput;
    }
    return super.fetchAndParseOutput(runId, taskId);
  }

  /**
   * Check Stage 1 output for contract violations (design §6.5.4, Req 7.18).
   * Returns a reason string when the output is malformed, or null when valid.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- pure function, no instance state needed
  private checkStage1Contract(_output: unknown): string | null { return null; }

  /**
   * Build the evaluator prompt with the given manifest's resolved context.
   * Shared by single-stage and two-stage paths.
   */
  /**
   * PRI-630 收敛契约 (SPEC §18.1): 解析上轮评估上下文 — 从 dependency
   * artificer 的 repairPayload.sourceEvaluatorTaskId 找到上轮 evaluator,
   * 读取其最近 principle artifact,按 rc-1/rc-2 守卫解析 evaluation 字段。
   * requirements 用稳定 id (req-1..N, 上轮 requiredChanges 顺序)。
   * 解析失败 → 结构化降级事件 + undefined (保持既有行为,可观测)。
   */
  private async resolvePreviousEvaluation(
    taskId: string,
    repairPayload: RepairPayload,
    repairArtifactContentJson: string,
  ): Promise<PreviousEvaluationContext | undefined> {
    const priorTaskId = repairPayload.sourceEvaluatorTaskId;
    const priorArtifactJson = await this.artifactStore
      .listBySourceTaskId(priorTaskId)
      .then((artifacts) => {
        let latest = null as { updatedAt: string; contentJson: string } | null;
        for (const a of artifacts) {
          if (a.artifactKind !== 'principle') continue;
          if (!latest || a.updatedAt > latest.updatedAt) latest = a;
        }
        return latest?.contentJson ?? null;
      })
      .catch(() => null);
    if (priorArtifactJson === null) {
      this.emitEvent('previous_evaluation_context_degraded', taskId, {
        priorEvaluatorTaskId: priorTaskId,
        reason: 'prior_evaluation_artifact_unavailable',
        repairIteration: repairPayload.repairIteration,
      });
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(priorArtifactJson);
    } catch {
      this.emitEvent('previous_evaluation_context_degraded', taskId, {
        priorEvaluatorTaskId: priorTaskId,
        reason: 'prior_evaluation_artifact_unparseable',
      });
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    // runtime-contract-exempt: ERR-001 object-guarded unknown property extraction; typeof guard follows immediately
    const {evaluation} = parsed as { evaluation?: unknown };
    if (typeof evaluation !== 'object' || evaluation === null) {
      this.emitEvent('previous_evaluation_context_degraded', taskId, {
        priorEvaluatorTaskId: priorTaskId,
        reason: 'prior_evaluation_shape_invalid',
      });
      return undefined;
    }
    const ev = evaluation as Record<string, unknown>;
    const decision = typeof ev.decision === 'string' ? ev.decision : 'needs_revision';
    const score = typeof ev.score === 'number' && Number.isFinite(ev.score) ? Math.min(1, Math.max(0, ev.score)) : 0;
    const toStringArray = (v: unknown, cap: number): string[] => {
      if (!Array.isArray(v)) return [];
      const out: string[] = [];
      for (const item of v.slice(0, cap)) {
        if (typeof item === 'string' && item.trim() !== '') out.push(item.slice(0, 500));
      }
      return out;
    };
    const concerns = toStringArray(ev.concerns, 10);
    const requiredChanges = toStringArray(ev.requiredChanges, 10);
    // PRI-630 P1 评审修复: 需求身份跨轮稳定 — 上轮 echo 的 requirementLedger
    // (若有) 中 still_open/regressed 条目保留原 id 与原 statement;本轮
    // requiredChanges 的非重述项作为新需求从最大序号递增。无 ledger 时
    // (首个修复轮) 退回顺序编号。
    let prevLedger: { id: string; statement: string; status: string }[] | undefined;
    if (Array.isArray(ev.requirementLedger)) {
      prevLedger = [];
      for (const entry of ev.requirementLedger) {
        if (entry === null || typeof entry !== 'object') continue;
        const rec = entry as { id?: unknown; statement?: unknown; status?: unknown };
        if (typeof rec.id !== 'string' || typeof rec.statement !== 'string') continue;
        if (rec.status !== 'resolved' && rec.status !== 'still_open' && rec.status !== 'regressed') continue;
        prevLedger.push({ id: rec.id, statement: rec.statement, status: rec.status });
      }
    }
    const requirements = deriveRequirementLedger(prevLedger, requiredChanges);
    // 修复说明: 当前 (被修复) artificer artifact 的声明性摘要 — 有界提取
    let repairSummary: string | undefined;
    try {
      const art = JSON.parse(repairArtifactContentJson) as unknown;
      if (typeof art === 'object' && art !== null) {
        // runtime-contract-exempt: ERR-001 object-guarded unknown property extraction; typeof guard follows immediately
        const { implementationSummary } = art as { implementationSummary?: unknown };
        if (typeof implementationSummary === 'string' && implementationSummary.trim() !== '') {
          repairSummary = implementationSummary.slice(0, 800);
        }
      }
    } catch {
      repairSummary = undefined;
    }
    return {
      decision,
      score,
      concerns,
      requirements,
      repairIteration: repairPayload.repairIteration,
      ...(repairSummary !== undefined ? { repairSummary } : {}),
    };
  }

  private buildEvaluatorPrompt(taskId: string, context: EvaluatorContext, manifest: typeof EVALUATOR_STAGE1_MANIFEST): string {
    let parsedArtificerArtifact: unknown = null;
    if (context.artificerArtifact) {
      try { parsedArtificerArtifact = JSON.parse(context.artificerArtifact); } catch { parsedArtificerArtifact = context.artificerArtifact; }
    }
    let parsedScribeArtifact: unknown = undefined;
    if (context.scribeArtifact) {
      try { parsedScribeArtifact = JSON.parse(context.scribeArtifact); } catch { parsedScribeArtifact = context.scribeArtifact; }
    }
    // Resolve manifest-injected focused fields (Layer 1).
    const artificerPred = toArtificerPredecessor(context);
    if (artificerPred !== null) {
      const resolved = this.resolveContextInjection(taskId, manifest, artificerPred.contentJson);
      if (resolved.mode === 'focused') {
        parsedArtificerArtifact = resolved.fields;
      }
    }
    const builder = new EvaluatorPromptBuilder();
    const { message } = builder.buildPrompt({
      taskId,
      contextHash: context.contextHash,
      artificerArtifact: parsedArtificerArtifact,
      scribeArtifact: parsedScribeArtifact,
      sourceArtificerArtifactId: context.sourceArtificerArtifactId ?? '',
      previousEvaluation: context.previousEvaluation,
      hostToolCatalog: this.hostToolCatalog ?? undefined,
    });
    return message;
  }

  /** Original single-stage invokeRuntime (flag-off path). */
  private async invokeRuntimeSingleStage(taskId: string, context: EvaluatorContext): Promise<RunHandle> {
    const message = this.buildEvaluatorPrompt(taskId, context, EVALUATOR_STAGE1_MANIFEST);
    return this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'evaluator-output-v1',
      timeoutMs: this.resolvedOptions.timeoutMs,
    });
  }

  async validateOutput(output: unknown, taskId: string, context: EvaluatorContext): Promise<PeerRunnerValidationResult> {
    // PRI-630 P1 评审修复: 修复轮把上轮 requirement ids 传入做完整覆盖校验
    // (缺 priorRequirementStatuses 或漏 id → output_invalid),不再仅靠 prompt。
    const convergence = context.previousEvaluation
      ? { expectedRequirements: context.previousEvaluation.requirements.map((r) => ({ id: r.id, statement: r.statement })) }
      : undefined;
    const result = await this.validator.validate(output, taskId, context.sourceArtificerArtifactId ?? undefined, convergence);

    // Trust-boundary: validator is an injected dependency returning `string | undefined`
    // for errorCategory. We must not `as`-cast; validate at runtime (ERR-001, ERR-005).
    const rawCategory = result.errorCategory;
    let errorCategory: PDErrorCategory | undefined;
    if (rawCategory == null) {
      errorCategory = undefined;
    } else if (isPDErrorCategory(rawCategory)) {
      errorCategory = rawCategory;
    } else {
      // Invalid errorCategory from validator — fail loud, do not pass through
      return {
        valid: false,
        errors: [...result.errors, `invalid errorCategory: ${rawCategory}`],
        errorCategory: 'output_invalid',
      };
    }

    return {
      valid: result.valid,
      errors: result.errors,
      errorCategory,
    };
  }

  // eslint-disable-next-line @typescript-eslint/max-params
  async succeedTask(
    taskId: string,
    runId: string,
    output: EvaluatorOutputV1,
    task: TaskRecord,
    contextHash: string,
    context: EvaluatorContext,
  ): Promise<PeerRunnerResult<EvaluatorOutputV1>> {
    // Lineage consistency: sourceArtificerArtifactId must match buildContext result (ERR-004).
    if (context.sourceArtificerArtifactId && output.sourceArtificerArtifactId !== context.sourceArtificerArtifactId) {
      throw new PDRuntimeError(
        'output_invalid',
        `sourceArtificerArtifactId mismatch: expected ${context.sourceArtificerArtifactId}, got ${output.sourceArtificerArtifactId}`,
      );
    }

    // Store output before marking succeeded
    try {
      await this.stateManager.updateRunOutput(runId, JSON.stringify(output));
    } catch (updateErr) {
      this.emitEvent('update_output_failed', taskId, {
        runId,
        errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
      throw updateErr;
    }

    // Resolve lineage artifact IDs
    let lineageArtifactIds: string[] = [];
    let lineageHasRejected = false;
    try {
      const lineageResult = await this.resolveLineageArtifactIds(taskId);
      lineageArtifactIds = lineageResult.ids;
      lineageHasRejected = lineageResult.hasRejected;
    } catch (lineageErr) {
      this.emitEvent('lineage_resolve_failed', taskId, {
        runId,
        errorMessage: lineageErr instanceof Error ? lineageErr.message : String(lineageErr),
      });
    }

    if (lineageHasRejected) {
      this.emitEvent('lineage_partial', taskId, {
        runId,
        resolvedCount: lineageArtifactIds.length,
        warning: 'Some dependency artifact queries were rejected; lineage may be incomplete',
      });
    }

    // Write PIArtifact via artifactStore (idempotent upsert)
    const artifactId = `pi-art-${taskId}-${runId}`;
    const now = new Date().toISOString();
    try {
      await this.artifactStore.upsertArtifact({
        artifactId,
        artifactKind: 'principle',
        sourceTaskId: taskId,
        lineageArtifactIds,
        validationStatus: 'pending',
        // Layer 0 (design §6.1, task 3.11): evaluator's edge predecessor is
        // artificer (NOT scribe — scribe is loaded for code review but is not
        // the edge predecessor, F17). The scribe artifact still flows through
        // the separate extractScribeArtifactId path (F3).
        contentJson: this.buildArtifactContentJson(taskId, 'evaluator', output, toArtificerPredecessor(context)),
        createdAt: now,
        updatedAt: now,
      });
    } catch (artifactErr) {
      this.emitEvent('artifact_write_failed', taskId, {
        runId,
        errorMessage: artifactErr instanceof Error ? artifactErr.message : String(artifactErr),
      });
      return this.retryOrFail({
        taskId,
        task,
        errorCategory: 'artifact_commit_failed',
        failureReason: `PIArtifact write failed: ${artifactErr instanceof Error ? artifactErr.message : String(artifactErr)}`,
      });
    }

    // ── PRI-426: single-round adversarial sandbox replay ──
    // PRI-634 A2 (authority migration): gate necessity is decided by the
    // DURABLE Artificer artifact — assessArtificerCodeBearing() mirrors
    // assembleRuleArtifact()'s static preconditions exactly — never by
    // whether the LLM happened to emit optional V2 fields
    // (isEvaluatorOutputV2). A V2-shaped output over a non-code-bearing
    // Artificer keeps the legacy behavior (attempt replay, degrade with
    // telemetry) so the old path stays observable.
    //
    // PRI-423 contract: adversarialCasesToGoldenTrace yields an all-negative
    // trace. We MUST merge ≥1 positive case from the Artificer golden trace
    // before replaying, otherwise the merged trace fails validateGoldenTrace.
    //
    // The replay itself never throws into the caller — a sandbox/gate failure
    // degrades to adversarialResult.passed=false with a structured reason
    // (ERR-018). The principle artifact is already persisted, so
    // prompt-channel fallback remains available regardless of replay outcome
    // (PRD Decision 11d §h). The ONE deliberate exception is the R2 wiring
    // guard below: a code-bearing artifact without gateDeps fails loud
    // (capability_missing, permanent) instead of succeeding un-gated.
    let finalOutput: EvaluatorOutputV1 = output;

    // PRI-634 R4 (P1 provenance): diagnostic replay evidence is an
    // EXECUTION-TIME authoritative fact — set only when the deterministic
    // replay actually ran in THIS succeedTask invocation (see needs_revision
    // branch below). It is never derived from the LLM-supplied optional
    // `adversarialResult` field on the evaluator output, which a V2-shaped
    // output can carry without any sandbox ever running. Passing the fact
    // explicitly through applyEvaluatorDecisionEffects → maybeSeedArtificerRepair
    // keeps provenance structural rather than inferred.
    let diagnosticReplayEvidence: { ran: true; passed: boolean; failedCaseCount: number } | undefined;

    const gateAssessment = assessArtificerCodeBearing(context.artificerArtifact);
    const outputWantsGate = isEvaluatorOutputV2(output);
    const evaluatorDecision = output.evaluation.decision;

    if (evaluatorDecision !== 'approved') {
      // PRI-634 R3: For code-bearing artifacts with needs_revision (not
      // rejected), run the adversarial replay as DIAGNOSTIC evidence only.
      // The replay result is recorded in the artifact but does NOT override
      // the evaluator verdict — semantic review and deterministic replay
      // are complementary evidence sources, not a parent-child authority
      // chain (PRI-629 review 2026-08-31).
      //
      // PRI-634 R4 (review 2026-08-31 P1-1): the diagnostic replay MUST
      // actually run here. executeDeterministicReplay is the verdict-agnostic
      // core — runAdversarialReplay short-circuits on decision !== 'approved'
      // and would silently skip, making this branch a no-op.
      const wantsGate = gateAssessment.codeBearing || outputWantsGate;
      if (evaluatorDecision === 'needs_revision' && wantsGate) {
        if (this.gateDeps) {
          let replaySucceeded = false;
          try {
            const replayOutcome = await this.executeDeterministicReplay(output, taskId, runId, context);
            if (replayOutcome.updatedOutput) {
              finalOutput = replayOutcome.updatedOutput;
              // Execution-time provenance: executeDeterministicReplay wrote
              // this adversarialResult in THIS invocation — record it as the
              // authoritative diagnostic evidence for the repair round.
              // Read from replayOutcome directly (which is EvaluatorOutputV2)
              // rather than finalOutput (which is typed as EvaluatorOutputV1).
              const replayAr = replayOutcome.updatedOutput.adversarialResult;
              if (replayAr) {
                diagnosticReplayEvidence = {
                  ran: true,
                  passed: replayAr.passed === true,
                  failedCaseCount: Array.isArray(replayAr.failedCases) ? replayAr.failedCases.length : 0,
                };
              }
              await this.stateManager.updateRunOutput(runId, JSON.stringify(finalOutput));
              try {
                // Re-persist with the canonical envelope (same as the
                // approved-path re-persist below) — the replay carries the
                // deterministic evidence that downstream consumers read.
                await this.artifactStore.upsertArtifact({
                  artifactId,
                  artifactKind: 'principle',
                  sourceTaskId: taskId,
                  lineageArtifactIds,
                  validationStatus: 'pending',
                  contentJson: this.buildArtifactContentJson(taskId, 'evaluator', finalOutput, toArtificerPredecessor(context)),
                  createdAt: now,
                  updatedAt: new Date().toISOString(),
                });
              } catch { /* best-effort persist */ }
              const v2 = finalOutput as { adversarialResult?: { passed?: boolean } };
              replaySucceeded = v2.adversarialResult?.passed === true;
            }
          } catch (replayError) {
            this.emitEvent('adversarial_replay_error', taskId, {
              runId,
              reason: replayError instanceof Error ? replayError.message : String(replayError),
            });
          }
          if (replaySucceeded) {
            this.emitEvent('adversarial_replay_diagnostic_passed', taskId, {
              runId,
              reason: 'diagnostic_replay_passed_despite_needs_revision',
              nextAction: 'repair_loop_continues_with_replay_evidence',
            });
          } else {
            this.emitEvent('adversarial_replay_diagnostic_failed', taskId, {
              runId,
              reason: 'diagnostic_replay_ran_but_did_not_fully_pass',
              nextAction: 'repair_loop_or_next_review_round',
            });
          }
        } else {
          // needs_revision is not a rule-assembly terminal: missing gateDeps
          // only costs the diagnostic evidence, never the verdict. Keep
          // observable (A3) but do not fail-loud (R2's fail-loud is scoped to
          // the approved binding path where success would otherwise be a lie).
          this.emitEvent('adversarial_replay_skipped', taskId, {
            runId,
            reason: 'gate_deps_not_injected',
            nextAction: 'wire_gateDeps_createProductionGateDeps_into_evaluator_runner_assembly',
          });
        }
      } else if (wantsGate) {
        this.emitEvent('adversarial_replay_skipped', taskId, {
          runId,
          reason: 'evaluation_not_approved',
          nextAction: 'repair_loop_or_next_review_round',
        });
      }
    } else if (!this.gateDeps) {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'gate_deps_not_injected',
        nextAction: 'wire_gateDeps_createProductionGateDeps_into_evaluator_runner_assembly',
      });
      if (gateAssessment.codeBearing) {
        // PRI-634 R2 (wiring regression guard): a code-bearing Artificer
        // artifact REQUIRES the deterministic gate. Proceeding would yield
        // succeeded + adversarialResult=null — the exact state that broke
        // chain 48371236. capability_missing is a permanent error: the task
        // fails loud (markTaskFailed) instead of retry-burning LLM budget —
        // a missing gateDeps is an assembly defect, not a transient fault.
        return this.retryOrFail({
          taskId,
          task,
          errorCategory: 'capability_missing',
          failureReason: `PRI-634 R2: Artificer artifact ${context.sourceArtificerArtifactId ?? '(unknown)'} is code-bearing but EvaluatorRunner was assembled without gateDeps — deterministic adversarial replay cannot run. Fix: inject gateDeps: createProductionGateDeps() into the EvaluatorRunner assembly.`,
        });
      }
    } else if (gateAssessment.codeBearing || outputWantsGate) {
      const replayOutcome = await this.runAdversarialReplay(output, taskId, runId, context);
      if (replayOutcome.updatedOutput) {
        finalOutput = replayOutcome.updatedOutput;
        await this.stateManager.updateRunOutput(runId, JSON.stringify(finalOutput));
        // Re-persist the artifact with the populated adversarialResult so
        // downstream readers (Phase 6 assembly, orchestrator retry) see it.
        try {
          await this.artifactStore.upsertArtifact({
            artifactId,
            artifactKind: 'principle',
            sourceTaskId: taskId,
            lineageArtifactIds,
            validationStatus: 'pending',
            // Layer 0 (design §6.1): re-build the envelope on the final output
            // so the replay re-persist keeps the same `summary` /
            // `predecessorSummary` fields as the initial write (the first write
            // would otherwise be overwritten with a bare JSON.stringify).
            contentJson: this.buildArtifactContentJson(taskId, 'evaluator', finalOutput, toArtificerPredecessor(context)),
            createdAt: now,
            updatedAt: new Date().toISOString(),
          });
        } catch (replayPersistErr) {
          // Non-fatal: the principle artifact is already written. Log and
          // continue — adversarialResult is still on finalOutput in memory.
          this.emitEvent('adversarial_result_persist_failed', taskId, {
            runId,
            errorMessage: replayPersistErr instanceof Error ? replayPersistErr.message : String(replayPersistErr),
          });
        }
      } else if (gateAssessment.codeBearing) {
        // ── PRI-634 R3 (terminal-state invariant) ──
        // A code-bearing Artificer artifact that reached `approved` MUST leave
        // this block carrying an adversarialResult. Anything else reproduces
        // the chain-48371236 terminal state — approved with the deterministic
        // gate never executed, adversarialResult=null, and therefore no
        // pi-rule-* downstream — regardless of WHICH cause prevented the
        // replay (zero adversarial cases, no positive case, unparseable
        // artifact, conversion drift…). Telemetry is not recovery: a task that
        // ends `succeeded` here is indistinguishable from the original defect.
        //
        // errorCategory is `input_invalid` (already listed in
        // permanentErrorCategories) rather than `capability_missing`: the gate
        // IS wired correctly (R2 owns the wiring case) — the upstream
        // Artificer content simply cannot be turned into gate input. Permanent
        // because retrying the LLM cannot make the Artificer emit the missing
        // affectedTools / positive-case path.
        return this.retryOrFail({
          taskId,
          task,
          errorCategory: 'input_invalid',
          failureReason: `PRI-634 R3: Artificer artifact ${context.sourceArtificerArtifactId ?? '(unknown)'} is code-bearing and the evaluator approved it, but the deterministic adversarial replay did not run (reason: ${replayOutcome.skipReason ?? 'unknown'}). Refusing to report succeeded with adversarialResult=null — that is the chain-48371236 terminal state. Fix: have the Artificer emit affectedTools plus at least one positive golden-trace case carrying a path, or supply LLM adversarialCases.`,
        });
      }
    }

    // ── P0 (verdict drift): verdict + completion intent 原子落库 ──
    // 必须先于一切治理 side effect (validate bearer / seed repair / rule
    // assembly):side effect 已发生而 intent 未落 = crash 后重跑会重新问
    // LLM,新 verdict 与已发生副作用形成治理矛盾 (repair drift /
    // validation drift / validated-rule drift)。同 epoch crash/retry 重跑经
    // maybeResumePendingIntent resume,不重问。
    await this.recordCompletionOrThrow(taskId, runId, finalOutput.evaluation.decision);

    const ruleAssemblyInput = {
      artificerArtifact: context.artificerArtifact ?? null,
      sourceArtificerArtifactId: context.sourceArtificerArtifactId ?? null,
    };
    const sourceArtificerArtifactId = context.sourceArtificerArtifactId
      ?? finalOutput.sourceArtificerArtifactId
      ?? null;
    const effectResult = await this.applyEvaluatorDecisionEffects({
      taskId, runId, finalOutput, task, artifactId, contextHash, sourceArtificerArtifactId, ruleAssemblyInput,
      // 执行时权威事实：仅本次 succeedTask 真正运行了诊断重放才存在
      diagnosticReplayEvidence,
    });
    if (effectResult.kind === 'human_review') {
      return effectResult.result;
    }

    // ── P0 invariant 5: intent APPLIED 后才允许 terminal ──
    await this.markCompletionIntentAppliedOrThrow(taskId);

    const resultRef = `${this.config.resultRefPrefix}://${runId}`;

    try {
      await this.stateManager.markTaskSucceeded(taskId, resultRef);
    } catch (stateErr) {
      this.emitEvent('mark_succeeded_failed', taskId, {
        taskId,
        runId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }

    this.emitEvent('task_succeeded', taskId, {
      attemptCount: task.attemptCount,
      resultRef,
      evaluationDecision: finalOutput.evaluation.decision,
      evaluationScore: finalOutput.evaluation.score,
      ruleArtifactId: effectResult.ruleArtifactId,
    });

    return {
      status: 'succeeded',
      taskId,
      runId,
      artifactId,
      resultRef,
      contextHash,
      output: finalOutput,
      attemptCount: task.attemptCount,
    };
  }

  /**
   * P0 (verdict drift): 执行 decision 的治理效果 (fresh 与 resume 共用,
   * 幂等): approved → validate principle bearer;needs_revision (repair loop
   * on) → deterministic repair seed / max-iterations needs_human_review;
   * rejected → 无效果。
   *
   * 返回非 null = terminal 结果 (needs_human_review 族,caller 直接返回,
   * 不得 markTaskSucceeded);null = effects 完成,caller 标 intent applied
   * 后 markSucceeded。
   */
  private async applyEvaluatorDecisionEffects(args: {
    taskId: string;
    runId: string;
    finalOutput: EvaluatorOutputV1;
    task: TaskRecord;
    artifactId: string;
    contextHash: string;
    sourceArtificerArtifactId: string | null;
    ruleAssemblyInput: RuleAssemblyInput;
    /**
     * PRI-629 Owner verdict override (accept_current→approved /
     * reject_current→rejected)。提供时以 override 为效果分派依据 — 机器
     * verdict (finalOutput.evaluation.decision) 保持不变 (INV-03)。
     */
    decisionOverride?: 'approved' | 'rejected';
    /**
     * PRI-634 R4 (P1 provenance): 本次 succeedTask 执行中由
     * executeDeterministicReplay 真正产生的诊断重放 evidence。来自执行控制流
     * 的权威事实,绝不从 LLM 可伪造的 finalOutput.adversarialResult 反推。
     * resume / owner-override 路径无 live replay → undefined (fail-closed)。
     */
    diagnosticReplayEvidence?: { ran: true; passed: boolean; failedCaseCount: number } | undefined;
  }): Promise<
    | { kind: 'human_review'; result: PeerRunnerResult<EvaluatorOutputV1> }
    | { kind: 'completed'; ruleArtifactId: string | null }
  > {
    const { taskId, runId, finalOutput, task, artifactId, contextHash, sourceArtificerArtifactId, diagnosticReplayEvidence } = args;
    const decision = args.decisionOverride ?? finalOutput.evaluation.decision;

    // ── Evaluator-specific: validate principle-bearing Scribe artifact ──
    // This is the critical business logic: approved evaluator must validate
    // the Scribe principle artifact, NOT the Artificer plan artifact.
    // Idempotent: repeated updateValidationStatus('validated') is safe —
    // crash-resume re-applies without contradiction.
    if (decision === 'approved') {
      const principleArtifactId = await this.resolvePrincipleBearerArtifact(finalOutput, taskId);
      if (principleArtifactId) {
        try {
          const updated = await this.artifactStore.updateValidationStatus(
            principleArtifactId,
            'validated',
          );
          if (!updated) {
            // updateValidationStatus returned false — deterministic store
            // inconsistency (bearer 不在 store);结构化降级 (telemetry +
            // rollout 侧 resolveActivationCandidate 兜底 needs_human_review)。
            this.emitEvent('source_validation_update_not_found', taskId, {
              runId,
              sourceArtifactId: principleArtifactId,
              reason: 'principle_artifact_not_found_in_store',
              nextAction: 'verify_artifact_lineage_and_store_consistency',
            });
          }
        } catch (updateErr) {
          this.emitEvent('source_validation_update_failed', taskId, {
            runId,
            sourceArtifactId: principleArtifactId,
            errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
            nextAction: 'task_will_retry; repeated validated write is idempotent',
          });
          // P0 (INV-2): bearer validated 是 approved 的 required effect —
          // 存储写失败必须重试 (resume 幂等重放),不得吞掉后标 intent applied。
          throw updateErr;
        }
      }

      // ── P0-B (verdict drift 完整性): rule assembly 是治理 side effect ──
      // validated rule 会被 RuleHostWriter.canActivate 消费,必须在 durable
      // completion intent 之后执行 (原顺序: assembly 在 intent 前 → crash 后
      // 新 verdict 可与已 validated rule 冲突)。fresh 与 resume 共用本路径;
      // resume 的 assembly 输入由 durable lineage 重建 (store 按
      // sourceArtificerArtifactId 取 contentJson),deterministic
      // pi-rule-<taskId>-<runId> 保证重放不重复。
      if (isEvaluatorOutputV2(finalOutput) && finalOutput.adversarialResult?.passed === true) {
        let lineageIds: readonly string[] = [];
        try {
          lineageIds = (await this.resolveLineageArtifactIds(taskId)).ids;
        } catch (lineageErr) {
          this.emitEvent('lineage_resolve_failed', taskId, {
            runId,
            errorMessage: lineageErr instanceof Error ? lineageErr.message : String(lineageErr),
          });
        }
        const ruleArtifactId = await this.assembleRuleArtifact(
          finalOutput, taskId, runId, args.ruleAssemblyInput, lineageIds,
        );
        return { kind: 'completed', ruleArtifactId };
      }
      return { kind: 'completed', ruleArtifactId: null };
    }

    // ── PRI-509: Evaluator→Artificer Repair Loop ──
    // needs_revision 且 repair loop 开启: seed 确定性 ID 的 repair 任务
    // (幂等,crash-resume 不重复);max iterations (2) → needs_human_review。
    if (decision === 'needs_revision' && this.isRepairLoopEnabled()) {
      const repairOutcome = await this.maybeSeedArtificerRepair(
        taskId,
        { runId, output: finalOutput, sourceArtificerArtifactId, diagnosticReplayEvidence },
      );
      if (repairOutcome.kind === 'max_iterations_reached') {
        // PRI-629: budget 耗尽(decision-capable)与 seed 失败(recovery)拆分原因码
        const reasonCode = repairOutcome.detail === 'budget_exhausted'
          ? HUMAN_REVIEW_REASON.evaluatorRepairBudgetExhausted
          : HUMAN_REVIEW_REASON.evaluatorRepairSeedFailed;
        // Fail loud (rc-9, EP-03, ERR-002): mark the task needs_human_review
        // so it does NOT stay in 'leased' state (which would cause the lease
        // to expire and the evaluator to re-run the same verdict infinitely).
        // P0 (INV-2): needs_human_review 是本 completion 的 materialize 操作 —
        // fail-closed: 写失败 throw → retry_wait → 入口门 resume 同一效果,
        // 不问 LLM;禁止吞错后继续 (intent applied ⇔ effect 已 durable)。
        const resultRef = `${this.config.resultRefPrefix}://${runId}`;
        await this.markNeedsHumanReviewOrThrow(taskId, { runId, reasonCode, sourceArtifactId: artifactId });
        this.emitEvent('task_needs_human_review', taskId, {
          attemptCount: task.attemptCount,
          resultRef,
          evaluationDecision: finalOutput.evaluation.decision,
          evaluationScore: finalOutput.evaluation.score,
          ruleArtifactId: null,
          reason: `repair_loop_${reasonCode}`,
        });
        return {
          kind: 'human_review',
          result: {
            status: 'succeeded',
            taskId,
            runId,
            artifactId,
            resultRef,
            contextHash,
            output: finalOutput,
            attemptCount: task.attemptCount,
          },
        };
      }
      // repairOutcome.kind === 'repair_seeded' → fall through (completed)
    }
    // rejected / needs_revision (repair loop off): 无治理效果 — commit 门的
    // transition decision 依据 durable runnerDecision fail-closed。
    return { kind: 'completed', ruleArtifactId: null };
  }

  /**
   * PRI-509: Resolve the prior repair iteration by reading the dependency
   * artificer task's repairPayload (rc-7: written at task creation, never
   * inferred at read). Returns 0 when the dependency artificer has no
   * repairPayload (Round-1 evaluator → first repair).
   *
   * Loop state freshness (EP-05, ERR-015/018/019): each evaluator round reads
   * the CURRENT dependency artificer's repairPayload — never a cached value.
   */
  private async resolvePriorRepairIteration(taskId: string): Promise<number> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) return 0;

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    for (const depId of deps) {
      const depTask = await this.stateManager.getTask(depId);
      if (!depTask) continue;
      if (depTask.taskKind !== 'artificer') continue;

      const piDepTask = hydratePITaskRecord(depTask);
      // rc-5: use Object.hasOwn to check repairPayload presence.
      if (piDepTask?.repairPayload && typeof piDepTask.repairPayload.repairIteration === 'number') {
        return piDepTask.repairPayload.repairIteration;
      }
      // First artificer (no repairPayload) → prior iteration = 0.
      return 0;
    }
    return 0;
  }

  /**
   * 把 runner verdict 持久化进任务 diagnosticJson(commit 门控的输入)。
   * 失败不静默 (rc-9): emitEvent 后吞掉 — verdict 已在 events/runs 中可观测,
   * 且 commit 门对缺失 verdict 走 legacy 推进,不会因记录失败而卡链。
   */
  // ── P0 (verdict drift): completion intent — record / applied / resume ──

  /**
   * P0 (INV-2): needs_human_review 是 completion effect 的 materialize 操作 —
   * fail-closed + read-back。写失败 throw → retry_wait → 入口门 resume 同一
   * effect,不问 LLM;禁止吞错后让 caller 标 intent applied
   * (intent applied ⇔ 其 durable effect 已 materialize)。
   */
  private async markNeedsHumanReviewOrThrow(
    taskId: string,
    review: { runId: string; reasonCode: string; sourceArtifactId: string },
  ): Promise<void> {
    const { runId, reasonCode, sourceArtifactId } = review;
    try {
      // PRI-629: status + humanReviewContext 同一次 task-row mutation 原子落库
      // (SPEC §4 — context 缺失的 NHR 是 legacy,只能靠推断)。
      const raw = await this.stateManager.getTask(taskId);
      if (!raw) throw new Error(`task ${taskId} not found`);
      const piTask = hydratePITaskRecord(raw);
      if (!piTask) throw new Error(`task ${taskId} not hydratable`);
      let sourceArtifactHash: string | undefined;
      try {
        const artifact = await this.artifactStore.getArtifactById(sourceArtifactId);
        if (artifact) sourceArtifactHash = computeArtifactContentHash(artifact.contentJson);
      } catch {
        sourceArtifactHash = undefined; // hash 可选 — capability 侧要求 artifact 存在,届时重算
      }
      const context: HumanReviewContext = {
        reasonCode,
        sourceRunId: runId,
        sourceArtifactId,
        ...(sourceArtifactHash !== undefined ? { sourceArtifactHash } : {}),
        revisionEpoch: piTask.revisionCount ?? 0,
        createdAt: new Date().toISOString(),
      };
      const merged: PITaskMetadata = mergePITaskMetadata(piTask, { humanReviewContext: context });
      await this.stateManager.updateTask(taskId, {
        status: 'needs_human_review',
        diagnosticJson: createPITaskDiagnosticJson(merged),
      });
      // read-back invariant (INV-2): 只有 effect durable 才允许 caller 标 applied
      const current = await this.stateManager.getTask(taskId);
      if (!current || current.status !== 'needs_human_review') {
        throw new PDRuntimeError(
          'storage_unavailable',
          `needs_human_review effect not durable for task ${taskId} (read-back status: ${current?.status ?? 'task_missing'})`,
        );
      }
    } catch (err) {
      this.emitEvent('repair_loop_mark_review_failed', taskId, {
        runId,
        reason: reasonCode,
        errorMessage: err instanceof Error ? err.message : String(err),
        nextAction: 'task_will_retry_then_resume_completion_intent_without_llm',
      });
      throw err;
    }
  }

  /**
   * verdict + completion intent 原子落库 (单次 metadata 写)。intent 的存在
   * 证明 output 已 durable (updateRunOutput 在 succeedTask 最前)。
   * 同 epoch crash/retry 重跑经 maybeResumePendingIntent resume,不重问 LLM。
   */
  private async recordCompletionOrThrow(taskId: string, runId: string, decision: string): Promise<void> {
    try {
      const raw = await this.stateManager.getTask(taskId);
      if (!raw) throw new Error(`task ${taskId} not found`);
      const piTask = hydratePITaskRecord(raw);
      if (!piTask) throw new Error(`task ${taskId} not hydratable`);
      const merged: PITaskMetadata = mergePITaskMetadata(piTask, {
        runnerDecision: decision === 'approved' || decision === 'needs_revision' || decision === 'rejected'
          ? decision
          : piTask.runnerDecision,
        completionIntent: {
          decision: decision as RunnerDecision,
          sourceRunId: runId,
          revisionEpoch: piTask.revisionCount ?? 0,
          status: 'pending',
        },
      });
      await this.stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson(merged));
    } catch (err) {
      // P0-3 (外部复核): 吞掉写失败 = succeeded 任务无 durable verdict,
      // commit 门退化为不可判定 — fail loud,由重试机制重写 (verdict 仍在 runs)。
      this.emitEvent('completion_record_failed', taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
        decision,
        nextAction: 'task_will_retry; record is idempotent overwrite',
      });
      throw err;
    }
  }

  /** intent APPLIED 后才允许 terminal (P0 invariant 5)。写失败 fail loud。 */
  private async markCompletionIntentAppliedOrThrow(taskId: string): Promise<void> {
    try {
      const raw = await this.stateManager.getTask(taskId);
      if (!raw) throw new Error(`task ${taskId} not found`);
      const piTask = hydratePITaskRecord(raw);
      if (!piTask?.completionIntent) return;
      const merged: PITaskMetadata = mergePITaskMetadata(piTask, {
        completionIntent: { ...piTask.completionIntent, status: 'applied' },
      });
      await this.stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson(merged));
    } catch (err) {
      this.emitEvent('completion_mark_applied_failed', taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
        nextAction: 'task_will_retry; effects are idempotent on resume',
      });
      throw err;
    }
  }

  /**
   * 入口恢复门 (BasePeerRunner hook): pending completion intent (同 epoch)
   * 是 recovery authority。返回非 null = 本次 run 以 resume 完成 (LLM 未被
   * 调用);返回 null = 走正常 LLM 管线。真正的 revision reopen 已清空
   * intent (新 epoch 允许新 verdict);epoch 不匹配的残留视为 stale。
   */
  protected override async maybeResumePendingIntent(
    taskId: string,
    leasedTask: TaskRecord,
  ): Promise<PeerRunnerResult<EvaluatorOutputV1> | null> {
    const piTask = hydratePITaskRecord(leasedTask);

    // ── PRI-629: pending Owner Resolution 优先于一切 (SPEC §10) ──
    // Owner accept_current / reject_current 已 durable 记录且任务被翻回
    // pending — 本次 run 应用 override,绝不重新调用 LLM。applied 但未
    // terminal 的 crash 窗口同样由此收敛 (SPEC §30)。
    const ownerOverride = piTask ? planOwnerVerdictOverrideResume(piTask) : null;
    if (ownerOverride) {
      return await this.applyOwnerVerdictOverrideAndFinalize(taskId, leasedTask, ownerOverride);
    }

    const intent = piTask?.completionIntent;
    if (!piTask || !intent || intent.status !== 'pending') {
      // P0 (INV-1/INV-5): applied 但任务未 terminal (标 applied 后、
      // markTaskSucceeded 写失败/crash 的窗口) — effects 已 materialize,
      // 不重问 LLM,直接补 terminal。
      if (piTask && intent && intent.status === 'applied'
        && intent.revisionEpoch === (piTask.revisionCount ?? 0)
        && leasedTask.status !== 'needs_human_review') {
        return await this.finalizeAppliedIntentTerminal({ taskId, decision: intent.decision, sourceRunId: intent.sourceRunId, leasedTask });
      }
      return null;
    }
    if (intent.revisionEpoch !== (piTask.revisionCount ?? 0)) {
      this.emitEvent('completion_intent_stale_epoch', taskId, {
        intentEpoch: intent.revisionEpoch,
        currentEpoch: piTask.revisionCount ?? 0,
        nextAction: 'reopen should have cleared intent; verify reopenTaskForRevision path',
      });
      return null;
    }
    this.emitEvent('completion_intent_resumed', taskId, {
      decision: intent.decision,
      sourceRunId: intent.sourceRunId,
    });

    const output = await this.recoverIntentOutput(taskId, intent.sourceRunId, intent.decision);
    const artifactId = `pi-art-${taskId}-${intent.sourceRunId}`;
    const contextHash = `resume-${intent.sourceRunId}`;
    // P0-B: rule assembly 输入由 durable lineage 重建 (fresh 路径来自内存
    // context;resume 不得依赖瞬时内存) — store 按 output 的
    // sourceArtificerArtifactId 取 artificer contentJson。
    const assemblySourceId = output.sourceArtificerArtifactId ?? null;
    let artificerContent: string | null = null;
    if (assemblySourceId) {
      try {
        const rec = await this.artifactStore.getArtifactById(assemblySourceId);
        artificerContent = rec?.contentJson ?? null;
      } catch {
        artificerContent = null; // assembly 将结构化降级 (rule_assembly_failed)
      }
    }
    const effectResult = await this.applyEvaluatorDecisionEffects({
      taskId,
      runId: intent.sourceRunId,
      finalOutput: output,
      task: leasedTask,
      artifactId,
      contextHash,
      sourceArtificerArtifactId: assemblySourceId,
      ruleAssemblyInput: { artificerArtifact: artificerContent, sourceArtificerArtifactId: assemblySourceId },
    });
    if (effectResult.kind === 'human_review') {
      return effectResult.result;
    }
    await this.markCompletionIntentAppliedOrThrow(taskId);
    const resultRef = `${this.config.resultRefPrefix}://${intent.sourceRunId}`;
    try {
      await this.stateManager.markTaskSucceeded(taskId, resultRef);
    } catch (stateErr) {
      this.emitEvent('mark_succeeded_failed', taskId, {
        taskId,
        runId: intent.sourceRunId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }
    this.emitEvent('task_succeeded', taskId, {
      attemptCount: leasedTask.attemptCount,
      resultRef,
      evaluationDecision: output.evaluation.decision,
      evaluationScore: output.evaluation.score,
      ruleArtifactId: effectResult.ruleArtifactId,
      resumedFromCompletionIntent: true,
    });
    return {
      status: 'succeeded',
      taskId,
      runId: intent.sourceRunId,
      artifactId,
      resultRef,
      contextHash,
      output,
      attemptCount: leasedTask.attemptCount,
    };
  }

  /**
   * P0 (INV-1/INV-5): applied intent 的补 terminal — effects 已 materialize
   * (applied ⇒ INV-2 保证),仅 markTaskSucceeded 缺失。不调用 LLM。
   */
  private async finalizeAppliedIntentTerminal(args: {
    taskId: string;
    decision: RunnerDecision;
    sourceRunId: string;
    leasedTask: TaskRecord;
  }): Promise<PeerRunnerResult<EvaluatorOutputV1>> {
    const { taskId, decision, sourceRunId, leasedTask } = args;
    this.emitEvent('completion_intent_finalize_terminal', taskId, {
      sourceRunId,
      taskStatus: leasedTask.status,
    });
    const output = await this.recoverIntentOutput(taskId, sourceRunId, decision);
    const resultRef = `${this.config.resultRefPrefix}://${sourceRunId}`;
    try {
      await this.stateManager.markTaskSucceeded(taskId, resultRef);
    } catch (stateErr) {
      this.emitEvent('mark_succeeded_failed', taskId, {
        taskId,
        runId: sourceRunId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }
    this.emitEvent('task_succeeded', taskId, {
      attemptCount: leasedTask.attemptCount,
      resultRef,
      evaluationDecision: output.evaluation.decision,
      evaluationScore: output.evaluation.score,
      ruleArtifactId: null,
      finalizedFromAppliedIntent: true,
    });
    return {
      status: 'succeeded',
      taskId,
      runId: sourceRunId,
      artifactId: `pi-art-${taskId}-${sourceRunId}`,
      resultRef,
      contextHash: `resume-${sourceRunId}`,
      output,
      attemptCount: leasedTask.attemptCount,
    };
  }

  /**
   * PRI-629: 应用 Owner verdict override 并收敛 terminal。
   *
   * 顺序 (SPEC §10/§30): 恢复 durable output → 幂等效果 (override decision)
   * → completion intent 标 applied → resolution 标 applied → markTaskSucceeded。
   * 任何 crash 窗口重放同一 resolution,不重新调用 LLM。机器 verdict
   * (runnerDecision) 永不改写。
   */
  private async applyOwnerVerdictOverrideAndFinalize(
    taskId: string,
    leasedTask: TaskRecord,
    plan: OwnerOverrideResumePlan,
  ): Promise<PeerRunnerResult<EvaluatorOutputV1>> {
    const { resolution, overrideDecision } = plan;
    this.emitEvent('owner_resolution_applying', taskId, {
      resolutionId: resolution.resolutionId,
      action: resolution.action,
      machineDecision: resolution.machineDecision,
      effectiveDecision: overrideDecision,
      sourceRunId: resolution.sourceRunId,
    });

    // 恢复裁决时的 durable output — decision 必须与 resolution 记录的机器判定一致
    const output = await this.recoverIntentOutput(taskId, resolution.sourceRunId, resolution.machineDecision);

    // SPEC §20 纵深防御: 确定性对抗门失败不允许 approved override (capability
    // 层已挡一道;此处防事实漂移窗口)。
    if (overrideDecision === 'approved'
      && isEvaluatorOutputV2(output)
      && output.adversarialResult
      && output.adversarialResult.passed === false) {
      this.emitEvent('owner_resolution_rejected_by_policy', taskId, {
        resolutionId: resolution.resolutionId,
        reason: 'deterministic_hard_gate_failed',
        nextAction: 'owner_may_choose_revise_once_or_reject_current',
      });
      throw new PDRuntimeError(
        'input_invalid',
        `Owner accept_current refused for task ${taskId}: deterministic adversarial gate failed (owner cannot override hard safety)`,
      );
    }

    const artifactId = resolution.sourceArtifactId;
    const contextHash = `owner-override-${resolution.resolutionId}`;
    // rule assembly 输入由 durable lineage 重建 (与 intent resume 相同)
    const assemblySourceId = output.sourceArtificerArtifactId ?? null;
    let artificerContent: string | null = null;
    if (assemblySourceId) {
      try {
        const rec = await this.artifactStore.getArtifactById(assemblySourceId);
        artificerContent = rec?.contentJson ?? null;
      } catch {
        artificerContent = null;
      }
    }
    const effectResult = await this.applyEvaluatorDecisionEffects({
      taskId,
      runId: resolution.sourceRunId,
      finalOutput: output,
      task: leasedTask,
      artifactId,
      contextHash,
      sourceArtificerArtifactId: assemblySourceId,
      ruleAssemblyInput: { artificerArtifact: artificerContent, sourceArtificerArtifactId: assemblySourceId },
      decisionOverride: overrideDecision === 'approved' ? 'approved' : 'rejected',
    });
    if (effectResult.kind === 'human_review') {
      // P0 评审修复: 与 rollout 对称——override 驱动的 effects 落入 recovery
      // NHR 时,Owner 裁决已被执行,resolution 标 applied (否则 pending 残留
      // + Recover guard 拒绝 = 死胡同)。applied 后 Recover 放行,resume 门
      // 确定性重放。
      await markOwnerResolutionApplied({
        updateDiagnosticJson: (tid: string, json: string) => this.stateManager.updateTaskDiagnosticJson(tid, json),
        getTask: (tid: string) => this.stateManager.getTask(tid),
        taskId,
        resolutionId: resolution.resolutionId,
        appliedAt: new Date().toISOString(),
      });
      return effectResult.result;
    }
    await this.markCompletionIntentAppliedOrThrow(taskId);
    await markOwnerResolutionApplied({
      updateDiagnosticJson: (tid: string, json: string) => this.stateManager.updateTaskDiagnosticJson(tid, json),
      getTask: (tid: string) => this.stateManager.getTask(tid),
      taskId,
      resolutionId: resolution.resolutionId,
      appliedAt: new Date().toISOString(),
    });
    const resultRef = `${this.config.resultRefPrefix}://${resolution.sourceRunId}`;
    try {
      await this.stateManager.markTaskSucceeded(taskId, resultRef);
    } catch (stateErr) {
      this.emitEvent('mark_succeeded_failed', taskId, {
        taskId,
        runId: resolution.sourceRunId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }
    this.emitEvent('task_succeeded', taskId, {
      attemptCount: leasedTask.attemptCount,
      resultRef,
      evaluationDecision: output.evaluation.decision,
      evaluationScore: output.evaluation.score,
      ruleArtifactId: effectResult.ruleArtifactId,
      ownerResolutionApplied: resolution.resolutionId,
      effectiveDecision: overrideDecision,
    });
    return {
      status: 'succeeded',
      taskId,
      runId: resolution.sourceRunId,
      artifactId,
      resultRef,
      contextHash,
      output,
      attemptCount: leasedTask.attemptCount,
    };
  }

  /**
   * 从 runs 表恢复 intent 落库前已持久化的 validated output,并交叉核对
   * decision 与 intent 一致 (authority 记录一致性)。intent 的存在保证
   * updateRunOutput 曾成功;缺失/损坏/漂移 = 存储腐坏 → fail loud。
   */
  private async recoverIntentOutput(
    taskId: string,
    sourceRunId: string,
    expectedDecision: RunnerDecision,
  ): Promise<EvaluatorOutputV1> {
    const runs = await this.stateManager.getRunsByTask(taskId);
    const run = runs.find((r) => r.runId === sourceRunId);
    const raw = run?.outputPayload;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new PDRuntimeError('storage_unavailable', `completion intent output unrecoverable: run ${sourceRunId} of task ${taskId} has no outputPayload`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PDRuntimeError('storage_unavailable', `completion intent output unrecoverable: run ${sourceRunId} of task ${taskId} has unparseable outputPayload`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new PDRuntimeError('storage_unavailable', `completion intent output unrecoverable: run ${sourceRunId} of task ${taskId} payload is not an object`);
    }
    // runtime-contract-exempt: ERR-001 field access on object-guarded unknown; the decision value is typeof-checked immediately below and must equal the durable intent's decision
    const {evaluation} = (parsed as Record<string, unknown>);
    const decision = typeof evaluation === 'object' && evaluation !== null
      // runtime-contract-exempt: ERR-001 same object-guarded field access pattern as above; value compared against the expected decision, never trusted
      ? (evaluation as Record<string, unknown>).decision
      : undefined;
    if (decision !== expectedDecision) {
      throw new PDRuntimeError('storage_unavailable', `completion intent output unrecoverable: run ${sourceRunId} of task ${taskId} decision '${String(decision)}' does not match intent '${expectedDecision}'`);
    }
    // runtime-contract-exempt: ERR-001 output passed the full validate pipeline before persistence (run() trust boundary); this cast only narrows stored-not-fresh data whose decision was cross-checked above
    return parsed as EvaluatorOutputV1;
  }

  /**
   * PRI-509: Seed an artificer repair task or mark the evaluator task
   * needs_human_review when max iterations (2) are reached.
   *
   * Returns:
   *   - { kind: 'repair_seeded', taskId } — a new artificer repair task was created.
   *   - { kind: 'max_iterations_reached' } — task marked needs_human_review (fail loud).
   *
   * Trust boundary (rc-1, rc-2): evaluator output is already validated by
   * validateOutput before succeedTask is called. requiredChanges / concerns
   * are typed as readonly string[] on EvaluatorEvaluation, so element-level
   * re-validation is not required here (rc-4 N/A — not unknown at this point).
   */
  private async maybeSeedArtificerRepair(
    evaluatorTaskId: string,
    ctx: {
      runId: string;
      output: EvaluatorOutputV1;
      sourceArtificerArtifactId: string | null;
      /**
       * PRI-634 R4 (P1 provenance): 本次 succeedTask 执行中由
       * executeDeterministicReplay 真正产生的诊断重放 evidence。来自执行
       * 控制流的权威事实,绝不从 LLM 可伪造的 output.adversarialResult 反推。
       * 缺失 = 确定性重放未执行或未成功（skip/error/无 live 执行路径），
       * repairPayload 不应包含 diagnosticReplay 字段（fail-closed）。
       */
      diagnosticReplayEvidence?: { ran: true; passed: boolean; failedCaseCount: number } | undefined;
    },
  ): Promise<{ kind: 'repair_seeded'; taskId: string } | { kind: 'max_iterations_reached'; detail: 'budget_exhausted' | 'seed_failed' }> {
    const { runId: evaluatorRunId, output } = ctx;
    const priorRepairIteration = await this.resolvePriorRepairIteration(evaluatorTaskId);

    // ── Slice 5: max iterations (2) reached → fail loud ──
    if (priorRepairIteration >= 2) {
      // Task state update (→ needs_human_review) is handled by the caller
      // uniformly for all max_iterations_reached paths (rc-9: no silent
      // fallback; task must not be left in 'leased' state).
      this.emitEvent('repair_loop_max_iterations', evaluatorTaskId, {
        reason: 'max_repair_iterations_exceeded',
        nextAction: 'owner_manual_review_required',
        priorRepairIteration,
      });
      return { kind: 'max_iterations_reached', detail: 'budget_exhausted' };
    }

    // ── Slice 4: seed artificer repair task ──
    // sourceArtificerArtifactId 由 caller 解析 (fresh: context ?? output;
    // resume: output — intent 落库前 output 已 durable)。
    const sourceArtificerArtifactId = ctx.sourceArtificerArtifactId ?? output.sourceArtificerArtifactId;
    if (!sourceArtificerArtifactId) {
      // Lineage missing — cannot construct repairPayload. Fail loud (rc-3).
      this.emitEvent('repair_loop_lineage_missing', evaluatorTaskId, {
        runId: evaluatorRunId,
        reason: 'source_artificer_artifact_id_unresolved',
      });
      return { kind: 'max_iterations_reached', detail: 'seed_failed' };
    }

    // Construct the new repairPayload (repairIteration = prior + 1).
    // The 6 fields are sourced from the current evaluator output (rc-7:
    // fresh per-round data, never cached from a prior evaluator run).
    // PRI-634 R4 (P1 provenance): 使用执行时权威事实 diag-replay evidence
    //（来自 succeedTask 的 executeDeterministicReplay 调用），绝不从 LLM
    // 可伪造的 output.adversarialResult 反推。缺失 = 本次未执行确定性重放
    //（skip/error/无 live 路径），repairPayload 不包含 diagnosticReplay。
    const repairPayload: RepairPayload = {
      requiredChanges: [...output.evaluation.requiredChanges],
      concerns: [...output.evaluation.concerns],
      previousScore: output.evaluation.score,
      repairIteration: priorRepairIteration + 1,
      sourceArtificerArtifactId,
      sourceEvaluatorTaskId: evaluatorTaskId,
      ...(ctx.diagnosticReplayEvidence ? { diagnosticReplay: ctx.diagnosticReplayEvidence } : {}),
    };

    // Resolve the dependency artificer task to inherit dependencyTaskIds
    // (so the repair task points to the same scribe task, preserving lineage).
    const evaluatorTask = await this.stateManager.getTask(evaluatorTaskId);
    const evaluatorPiTask = evaluatorTask ? hydratePITaskRecord(evaluatorTask) : null;
    const evaluatorDeps = evaluatorPiTask?.dependencyTaskIds ?? [];

    // Inherit scribe-level dependency from the artificer task (the artificer's
    // own dependencyTaskIds), NOT the evaluator's dependencyTaskIds (which
    // point to the artificer, not the scribe).
    let inheritedDeps: string[] = [];
    let inheritedChannel: InternalizationChannel = 'prompt';
    let inheritedTimeoutMs = 300_000;
    let inheritedInputArtifactRefs: ArtifactRef[] = [];
    for (const depId of evaluatorDeps) {
      const depTask = await this.stateManager.getTask(depId);
      if (!depTask) continue;
      if (depTask.taskKind !== 'artificer') continue;
      const piArtificer = hydratePITaskRecord(depTask);
      if (!piArtificer) continue;
      inheritedDeps = piArtificer.dependencyTaskIds;
      inheritedChannel = piArtificer.channel;
      inheritedTimeoutMs = piArtificer.timeoutMs;
      inheritedInputArtifactRefs = piArtificer.inputArtifactRefs;
      break;
    }

    // Delegate to the injected seeder — core peer runners do NOT call
    // task-creation directly (architecture-regression.test.ts enforces
    // this boundary; the plugin layer wires the actual store mutation).
    if (!this.repairTaskSeeder) {
      // Seeder not injected despite flag enabled — configuration error.
      // Surface via telemetry (rc-9: no silent fallback) and treat as max
      // iterations reached so the caller skips markTaskSucceeded.
      this.emitEvent('repair_loop_seeder_missing', evaluatorTaskId, {
        runId: evaluatorRunId,
        reason: 'seed_artificer_repair_task_not_injected',
      });
      return { kind: 'max_iterations_reached', detail: 'seed_failed' };
    }

    try {
      const repairTaskId = await this.repairTaskSeeder({
        repairPayload,
        inheritedDependencyTaskIds: inheritedDeps,
        inheritedChannel,
        inheritedTimeoutMs,
        inheritedInputArtifactRefs,
      });
      this.emitEvent('repair_task_seeded', evaluatorTaskId, {
        repairTaskId,
        repairIteration: repairPayload.repairIteration,
        sourceArtificerArtifactId,
      });
      return { kind: 'repair_seeded', taskId: repairTaskId };
    } catch (seedErr) {
      // Surface failure — do not silently swallow (rc-9).
      this.emitEvent('repair_task_seed_failed', evaluatorTaskId, {
        runId: evaluatorRunId,
        errorMessage: seedErr instanceof Error ? seedErr.message : String(seedErr),
      });
      // Treat as max iterations reached so the caller skips markTaskSucceeded
      // and returns succeeded — the evaluator verdict stands; only the repair
      // seeding failed, which is logged.
      return { kind: 'max_iterations_reached', detail: 'seed_failed' };
    }
  }

  // ── Optional hooks ──────────────────────────────────────────────────────────

  /**
   * Re-inject taskId if stripped by stripLineageFields (PRI-272 / ERR-008).
   * Only fill when absent via Object.hasOwn — present-but-falsy values
   * must reach validation and fail loud (Runtime Contract Rule 3).
   *
   * generatedAt override is handled by the base class — subclasses must call
   * super.postFetchTransform() to inherit it.
   */
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown, _context: EvaluatorContext): void {
    super.postFetchTransform(taskId, untrustedOutput, _context);
    // Shared lineage echo gate (PRI-541). sourceArtificerArtifactId is
    // nullable (rule-plan candidates with no artificer predecessor): when
    // null there is no authoritative value, so only taskId is enforced.
    // This runs BEFORE checkLineageIntegrity, so a reconciled echo no longer
    // triggers the lineage_integrity_violation telemetry.
    const topFields = [{ field: 'taskId', authoritativeValue: taskId }];
    const traceFields = [] as { field: string; authoritativeValue: string }[];
    if (_context.sourceArtificerArtifactId !== null) {
      topFields.push({ field: 'sourceArtificerArtifactId', authoritativeValue: _context.sourceArtificerArtifactId });
      traceFields.push({ field: 'artificerArtifactId', authoritativeValue: _context.sourceArtificerArtifactId });
    }
    const correctedFields = reconcileLineageEcho(untrustedOutput, {
      topFields,
      ...(traceFields.length > 0 ? { trace: { traceField: 'sourceTrace', fields: traceFields } } : {}),
    });
    if (correctedFields.length > 0) {
      this.emitEvent('lineage_echo_corrected', taskId, { correctedFields });
    }
  }

  protected override emitSuccessTelemetry(taskId: string, output: EvaluatorOutputV1): void {
    this.emitEvent('decision_recorded', taskId, {
      evaluationDecision: output.evaluation.decision,
      evaluationScore: output.evaluation.score,
    });
  }

  /**
   * Check lineage strip contract after validation passes.
   * Validates sourceTrace.scribeArtifactId consistency (ERR-004, ERR-008).
   */
  protected override checkLineageIntegrity(taskId: string, output: EvaluatorOutputV1, _context: EvaluatorContext): void {
    // sourceTrace.artificerArtifactId must match sourceArtificerArtifactId
    if (output.sourceTrace.artificerArtifactId !== output.sourceArtificerArtifactId) {
      this.emitEvent('lineage_integrity_violation', taskId, {
        sourceArtificerArtifactId: output.sourceArtificerArtifactId,
        traceArtificerArtifactId: output.sourceTrace.artificerArtifactId,
        reason: 'sourceArtificerArtifactId_and_sourceTrace_artificerArtifactId_mismatch',
      });
    }
  }

  // ── PRI-426: adversarial sandbox replay ─────────────────────────────────────

  /**
   * Run a single-round adversarial sandbox replay (PRD Decision 11d).
   * PRI-634 A2/R1: the `output` is accepted in V1 shape too — a code-bearing
   * Artificer artifact requires the gate regardless of whether the evaluator
   * LLM emitted optional V2 fields. Only V2-shaped outputs can contribute
   * LLM-supplied adversarialCases (checked via isEvaluatorOutputV2 below).
   * Pure orchestration of pure functions:
   *   1. Skip if passive review failed (decision !== 'approved' is the LLM's
   *      short-circuit signal — no code to defend). Now observable (R9).
   *   2. Convert adversarialCases → GoldenTrace (all negative, PRI-423).
   *   3. Merge ≥1 positive case from the Artificer golden trace. If the
   *      artificer artifact has no goldenTraceCases (V1 mismatch), degrade:
   *      skip replay with telemetry — do NOT crash.
   *   4. Invoke evaluateRefinerRuleHostGate via injected gateDeps.
   *   5. Populate adversarialResult from the gate result.
   *
   * Never throws — all failure modes degrade to a returned result with a
   * structured reason (ERR-018). The caller persists the updated output.
   */
  // eslint-disable-next-line @typescript-eslint/max-params
  private async runAdversarialReplay(
    output: EvaluatorOutputV1,
    taskId: string,
    runId: string,
    context: EvaluatorContext,
  ): Promise<{
    readonly updatedOutput: EvaluatorOutputV2 | null;
    /**
     * Non-null when the deterministic gate did NOT run (degraded path).
     * PRI-634 R3: the caller converts this into a permanent fail-loud when the
     * Artificer artifact is code-bearing — `succeeded` + adversarialResult=null
     * is the chain-48371236 terminal state and must never be reachable.
     */
    readonly skipReason: string | null;
  }> {
    // (1) Passive review short-circuit: the LLM emits decision='needs_revision'
    // when any of intentConsistency/scopePrecision/traceCoverage fails. Only
    // replay when the LLM judged the code worth defending. The needs_revision
    // diagnostic path invokes executeDeterministicReplay directly (PRI-634 R4),
    // so this guard stays scoped to the approved binding path.
    if (output.evaluation.decision !== 'approved') {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'evaluation_not_approved',
        nextAction: 'repair_loop_or_next_review_round',
      });
      return { updatedOutput: null, skipReason: 'evaluation_not_approved' };
    }
    return this.executeDeterministicReplay(output, taskId, runId, context);
  }

  /**
   * PRI-634 R4: verdict-agnostic deterministic replay core. Runs the sandbox
   * gate against the Artificer implementation code and returns the updated
   * output carrying `adversarialResult`. Unlike runAdversarialReplay this does
   * NOT short-circuit on decision !== 'approved' — the caller decides when a
   * replay is useful (approved → binding; needs_revision → diagnostic
   * evidence). Never throws — all failure modes degrade to a returned result
   * with a structured reason (ERR-018). The caller persists the updated output.
   */
  // eslint-disable-next-line @typescript-eslint/max-params
  private async executeDeterministicReplay(
    output: EvaluatorOutputV1,
    taskId: string,
    runId: string,
    context: EvaluatorContext,
  ): Promise<{
    readonly updatedOutput: EvaluatorOutputV2 | null;
    readonly skipReason: string | null;
  }> {
    // gateDeps is non-null here — the callers only invoke this method when
    // this.gateDeps is set. Bind to a local to avoid re-asserting.
    // eslint-disable-next-line @typescript-eslint/prefer-destructuring
    const gateDeps = this.gateDeps;
    if (!gateDeps) {
      // Defensive — unreachable via the current callers (R2 fails loud before
      // this point). Kept observable so a future caller cannot silently
      // reintroduce the un-gated path (PRI-634 A3).
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'gate_deps_not_injected',
        nextAction: 'wire_gateDeps_createProductionGateDeps_into_evaluator_runner_assembly',
      });
      return { updatedOutput: null, skipReason: 'gate_deps_not_injected' };
    }
    // (2) Resolve the Artificer artifact early — we need it both to derive
    // the v2 adversarial spec (PRI-485) and to merge positive cases (PRI-423).
    if (!context.artificerArtifact) {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'no_artificer_artifact_in_context',
        nextAction: 'verify_buildContext_resolves_artificer_artifact',
      });
      return { updatedOutput: null, skipReason: 'no_artificer_artifact_in_context' };
    }

    const artificerParsed = this.parseArtificerArtifact(context.artificerArtifact);
    if (!artificerParsed) {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'artificer_artifact_unparseable',
        nextAction: 'verify_artificer_artifact_contentJson',
      });
      return { updatedOutput: null, skipReason: 'artificer_artifact_unparseable' };
    }

    const { implementationCode, goldenTraceCases, affectedTools } = artificerParsed;
    if (typeof implementationCode !== 'string' || implementationCode.trim() === '') {
      // Artificer output is V1 (no code) but the evaluator emitted V2. This is
      // a mismatch — degrade rather than replay against missing code.
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'artificer_artifact_has_no_implementation_code',
        nextAction: 'verify_artificer_l2_adapter_emitted_v2',
      });
      return { updatedOutput: null, skipReason: 'artificer_artifact_has_no_implementation_code' };
    }

    // Merge positive cases from the Artificer golden trace into the adversarial
    // trace. buildGoldenTraceFromArtificer validates each case structurally
    // (Runtime Contract Rule 4) and returns ok=false on any malformed entry.
    const positiveCases = this.extractPositiveCases(goldenTraceCases);
    if (positiveCases.length === 0) {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'no_positive_case_in_artificer_golden_trace',
        nextAction: 'verify_artificer_emitted_at_least_one_positive_case',
      });
      return { updatedOutput: null, skipReason: 'no_positive_case_in_artificer_golden_trace' };
    }

    // (3) PRI-485 Phase 6: auto-generate 5 v2 adversarial cases from the
    // Artificer's affectedTools + first positive case's path. These defend
    // against the most common false-positive patterns (unavailable/truncation/
    // alias/path/combination). Degrade with telemetry (rc-9) if the spec
    // cannot be derived — LLM-supplied adversarialCases still replay.
    // PRI-634 R1: V1-shaped outputs carry no adversarialCases — the merged
    // set below then relies entirely on the auto-generated v2 cases.
    const llmCases = isEvaluatorOutputV2(output) ? (output.adversarialCases ?? []) : [];
    const v2Cases = this.generateV2CasesFromArtificer(affectedTools, positiveCases, taskId, runId);
    const mergedAdversarialCases: readonly AdversarialCase[] = [...v2Cases, ...llmCases];

    // (4) No adversarial cases (neither v2-generated nor LLM-supplied) →
    // nothing to replay. codeReview may still be present (passive review only).
    // Previously a silent return (PRI-634 A3 hole #3); now observable (R9).
    //
    // PRI-634 R3: for a code-bearing Artificer artifact this is NOT a benign
    // degradation — it reproduces the chain-48371236 terminal state (approved
    // with no gate executed, adversarialResult=null, no pi-rule-* ever
    // emitted). The caller fails loud on this skipReason instead of reporting
    // succeeded. Non-code-bearing artifacts keep the legacy degrade (R1's
    // authority is the durable Artificer content, and only code-bearing
    // content can reach rule assembly).
    if (mergedAdversarialCases.length === 0) {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'no_adversarial_cases_after_merge',
        nextAction: 'verify_artificer_affectedTools_or_positive_case_path_derivable',
      });
      return { updatedOutput: null, skipReason: 'no_adversarial_cases_after_merge' };
    }

    // (5) Convert the merged adversarial cases to an all-negative GoldenTrace.
    const conversion = adversarialCasesToGoldenTrace(mergedAdversarialCases);
    if (!conversion.ok) {
      // Validator already accepted adversarialCases, so a conversion failure
      // here is a contract drift between validator and converter. Degrade loud.
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: `adversarial_conversion_failed: ${conversion.reason}`,
        nextAction: 'verify_adversarial_case_validator_alignment',
      });
      return { updatedOutput: null, skipReason: `adversarial_conversion_failed: ${conversion.reason}` };
    }

    const mergedTrace: GoldenTrace = {
      traceId: `golden-trace-evaluator-replay-${taskId}-${Date.now().toString(36)}`,
      sourceArtifactId: context.sourceArtificerArtifactId ?? undefined,
      version: 1,
      createdAt: new Date().toISOString(),
      cases: [...positiveCases, ...conversion.trace.cases],
    };

    // (6) Invoke the gate. evaluateRefinerRuleHostGate is a pure function that
    // catches its own sandbox throws internally (rejected_runtime_error), so
    // this await cannot throw on sandbox failure — but we guard anyway for
    // defense-in-depth (ERR-018: trust boundary at injected deps).
    let gateResult;
    try {
      gateResult = evaluateRefinerRuleHostGate(
        { code: implementationCode, goldenTrace: mergedTrace },
        gateDeps,
      );
    } catch (gateErr) {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: `gate_invocation_threw: ${gateErr instanceof Error ? gateErr.message : String(gateErr)}`,
        nextAction: 'verify_gate_deps_implementation',
      });
      const failedResult: EvaluatorAdversarialResult = {
        passed: false,
        failedCases: [],
      };
      return {
        updatedOutput: { ...output, adversarialResult: failedResult },
        skipReason: null,
      };
    }

    this.emitEvent('adversarial_replay', taskId, {
      runId,
      gateDecision: gateResult.decision,
      caseCount: mergedTrace.cases.length,
      failedCaseCount: gateResult.sandboxResult.failedCases.length,
    });

    // (7) Populate adversarialResult from the gate result.
    const accepted = gateResult.decision === 'accepted_shadow';
    const failedCases: AdversarialFailedCase[] = accepted
      ? []
      : this.mapFailedCases(gateResult, mergedAdversarialCases);

    const adversarialResult: EvaluatorAdversarialResult = {
      passed: accepted,
      failedCases,
    };

    return {
      updatedOutput: { ...output, adversarialResult },
      skipReason: null,
    };
  }

  /**
   * Parse the Artificer artifact contentJson defensively (Runtime Contract
   * Rule 1/2/5). Returns null on any structural issue — the caller degrades.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private parseArtificerArtifact(
    contentJson: string,
  ): {
    readonly implementationCode: unknown;
    readonly goldenTraceCases: unknown;
    readonly affectedTools: unknown;
    readonly requiresContextVersion: unknown;
    readonly evidenceRefs: unknown;
  } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contentJson);
    } catch {
      return null;
    }
    if (!EvaluatorRunner.isRecord(parsed)) return null;
    return {
      implementationCode: parsed.implementationCode,
      goldenTraceCases: parsed.goldenTraceCases,
      affectedTools: parsed.affectedTools,
      requiresContextVersion: parsed.requiresContextVersion,
      evidenceRefs: parsed.evidenceRefs,
    };
  }

  /**
   * Extract a principle ID from a PIArtifactRecord. Mirrors the logic in
   * activation/low-risk-writers.ts extractPrincipleId() but operates on
   * PIArtifactRecord (internalization module type) instead of PIArtifactSnapshot
   * (activation module type). Kept inline to avoid a cross-module runtime
   * dependency on the activation module.
   *
   * Resolution order:
   *   1. record.sourcePrincipleId (top-level field)
   *   2. parsed.principleId (contentJson)
   *   3. parsed.sourcePrincipleId (contentJson)
   *   4. parsed.principleDraft.title (contentJson — scribe output shape)
   */
  private static extractPrincipleIdFromArtifact(
    record: { sourcePrincipleId?: string; contentJson: string },
  ): string | undefined {
    if (typeof record.sourcePrincipleId === 'string' && record.sourcePrincipleId.trim() !== '') {
      return record.sourcePrincipleId.trim();
    }
    try {
      const parsed: unknown = JSON.parse(record.contentJson);
      if (!EvaluatorRunner.isRecord(parsed)) return undefined;
      const {principleId} = parsed;
      if (typeof principleId === 'string' && principleId.trim() !== '') {
        return principleId.trim();
      }
      const {sourcePrincipleId} = parsed;
      if (typeof sourcePrincipleId === 'string' && sourcePrincipleId.trim() !== '') {
        return sourcePrincipleId.trim();
      }
      const {principleDraft} = parsed;
      if (EvaluatorRunner.isRecord(principleDraft)) {
        const {title} = principleDraft;
        if (typeof title === 'string' && title.trim() !== '') {
          return title.trim();
        }
      }
    } catch {
      // contentJson unparseable — fall through
    }
    return undefined;
  }

  /**
   * Extract structurally-valid positive GoldenTraceCases from the Artificer
   * goldenTraceCases array. Uses buildGoldenTraceFromArtificer (which re-
   * validates each case) and filters for kind='positive'. Returns [] when
   * the input is missing/malformed — the caller degrades to a skip (ERR-069:
   * never trust unvalidated candidates).
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private extractPositiveCases(rawCases: unknown): GoldenTraceCase[] {
    if (!Array.isArray(rawCases)) return [];
    const buildResult = buildGoldenTraceFromArtificer({ cases: rawCases });
    if (!buildResult.ok) return [];
    return buildResult.trace.cases.filter((c) => c.kind === 'positive');
  }

  /**
   * PRI-485 Phase 6: derive the v2 adversarial case spec from the Artificer
   * artifact and generate the 5 canonical v2 cases.
   *
   * Spec derivation:
   *   - toolName: the first entry in `affectedTools` (validated as a non-empty
   *     string array). Falls back to the first positive case's toolName when
   *     affectedTools is missing/malformed — the rule still governs that tool.
   *   - targetPath: the first positive case's `params.path` (validated as a
   *     non-empty string). When absent, degrade with telemetry (rc-9) and
   *     return [] — v2 cases cannot be path-realistic without a target path.
   *   - canonicalKind: canonicalizeToolKind(toolName) — pure lookup.
   *
   * Never throws. All malformed inputs degrade to [] with a telemetry event
   * carrying a structured `reason` + `nextAction` (Runtime Contract Rule 9).
   */
  // eslint-disable-next-line @typescript-eslint/max-params
  private generateV2CasesFromArtificer(
    affectedTools: unknown,
    positiveCases: readonly GoldenTraceCase[],
    taskId: string,
    runId: string,
  ): readonly AdversarialCase[] {
    // Resolve toolName: prefer affectedTools[0], fall back to positive case.
    let toolName: string | null = null;
    if (Array.isArray(affectedTools) && affectedTools.length > 0) {
      const [first] = affectedTools;
      if (typeof first === 'string' && first.trim() !== '') {
        toolName = first;
      }
    }
    if (toolName === null && positiveCases.length > 0) {
      const [firstPos] = positiveCases;
      const posTool = firstPos?.toolName;
      if (typeof posTool === 'string' && posTool.trim() !== '') {
        toolName = posTool;
      }
    }
    if (toolName === null) {
      this.emitEvent('v2_adversarial_cases_skipped', taskId, {
        runId,
        reason: 'no_tool_name_for_v2_adversarial_cases',
        nextAction: 'verify_artificer_emitted_affectedTools_or_positive_case_toolName',
      });
      return [];
    }

    // Resolve targetPath: first positive case's params.path.
    const [firstPositive] = positiveCases;
    if (!firstPositive) {
      this.emitEvent('v2_adversarial_cases_skipped', taskId, {
        runId,
        reason: 'no_positive_case_for_v2_adversarial_cases',
        nextAction: 'verify_artificer_emitted_at_least_one_positive_case',
      });
      return [];
    }
    // PRI-634: golden-trace params are echoed verbatim from the host
    // trajectory, and the dominant write-tool schema names its target
    // `file_path` (OpenClaw / Claude Code), not `path`. Reading only `path`
    // made v2 auto-generation structurally unreachable on real chains: the
    // merged case set stayed empty, so the gate never ran and an
    // LLM-declared adversarialResult.passed=true could stand in for a real
    // replay (chain 48371236). Accept both spellings — this is the input that
    // makes the deterministic gate reachable at all.
    const { params } = firstPositive;
    const pathParam = resolveCasePathParam(params);
    if (pathParam === null) {
      this.emitEvent('v2_adversarial_cases_skipped', taskId, {
        runId,
        reason: 'no_path_param_for_v2_adversarial_cases',
        nextAction: 'verify_positive_case_has_string_path_or_file_path_param',
      });
      return [];
    }

    const canonicalKind = canonicalizeToolKind(toolName);
    // PRI-485 Phase 6: the 5 v2 templates are write-path semantics (alias /
    // path-boundary / combination all assume a write action). Generating them
    // for read/search/execute/agent/other tools would produce mismatched
    // negative cases (e.g. expected block on a read tool). Degrade with
    // telemetry (rc-9) and return [] — non-write tools fall back to the
    // LLM-supplied adversarial cases only.
    if (canonicalKind !== 'write') {
      this.emitEvent('v2_adversarial_cases_skipped', taskId, {
        runId,
        reason: 'non_write_canonical_kind_for_v2_adversarial_cases',
        nextAction: 'verify_artificer_target_tool_is_write_kind_or_supply_custom_adversarial_cases',
        toolName,
        canonicalKind,
      });
      return [];
    }
    return generateV2ContextAdversarialCases({
      toolName,
      targetPath: pathParam,
      canonicalKind,
    });
  }

  /**
   * Map sandbox failed cases to EvaluatorAdversarialResult.failedCases.
   *
   * The sandbox reports failedCases by caseId; we enrich each with the
   * adversarial case's attackType and expectedDecision. Cases not found in
   * the adversarial set (e.g. the merged positive case failed — which would
   * indicate a code bug, not an adversarial failure) are reported with
   * attackType='boundary' as a safe default and a note in the rationale
   * (Runtime Contract Rule 9: graceful degradation includes a reason).
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private mapFailedCases(
    gateResult: { readonly sandboxResult: { readonly failedCases: readonly { readonly caseId: string; readonly errorType: string; readonly message: string }[] } },
    adversarialCases: readonly { readonly caseId: string; readonly attackType: 'boundary' | 'omission' | 'inversion'; readonly expectedDecision: 'allow' | 'block' | 'propose_correction' }[],
  ): AdversarialFailedCase[] {
    const advById = new Map(adversarialCases.map((c) => [c.caseId, c]));
    return gateResult.sandboxResult.failedCases.map((fc) => {
      const adv = advById.get(fc.caseId);
      return {
        caseId: fc.caseId,
        attackType: adv?.attackType ?? 'boundary',
        actualDecision: fc.errorType,
        expectedDecision: adv?.expectedDecision ?? 'block',
        rationale: adv
          ? `${fc.errorType}: ${fc.message}`
          : `non-adversarial case ${fc.caseId} failed (${fc.errorType}: ${fc.message}) — likely a code defect, not an adversarial gap`,
      };
    });
  }

  // ── PRI-427: rule artifact assembly ────────────────────────────────────────

  /**
   * Assemble and persist the rule artifact when adversarial replay passed
   * (PRD Decision 5). The rule artifact carries implementationCode + the
   * Artificer full golden trace + ruleHostGateDecision, with artifactKind='rule'.
   * After a successful write, marks the artifact 'validated' so RuleHostWriter
   * can activate it.
   *
   * Returns the rule artifactId on success, null on any degradation (missing
   * code/trace, write failure, validation-update failure). Every null path
   * emits structured telemetry with a reason (Runtime Rule 9, ERR-018).
   */
  // eslint-disable-next-line @typescript-eslint/max-params
  private async assembleRuleArtifact(
    output: EvaluatorOutputV2,
    taskId: string,
    runId: string,
    assemblyInput: RuleAssemblyInput,
    lineageArtifactIds: readonly string[],
  ): Promise<string | null> {
    if (!assemblyInput.artificerArtifact) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: 'no_artificer_artifact_in_context',
        nextAction: 'verify_buildContext_resolves_artificer_artifact',
      });
      return null;
    }

    const artificerParsed = this.parseArtificerArtifact(assemblyInput.artificerArtifact);
    if (!artificerParsed) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: 'artificer_artifact_unparseable',
        nextAction: 'verify_artificer_artifact_contentJson',
      });
      return null;
    }

    const { implementationCode, goldenTraceCases, affectedTools, requiresContextVersion, evidenceRefs } = artificerParsed;
    if (typeof implementationCode !== 'string' || implementationCode.trim() === '') {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: 'artificer_artifact_has_no_implementation_code',
        nextAction: 'verify_artificer_l2_adapter_emitted_v2',
      });
      return null;
    }

    // Runtime Rule 4: validate the array shape before passing to the builder.
    // buildGoldenTraceFromArtificer re-validates each element structurally, but
    // the type signature requires an array — narrow with Array.isArray first.
    if (!Array.isArray(goldenTraceCases)) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: 'artificer_golden_trace_cases_not_array',
        nextAction: 'verify_artificer_emitted_goldenTraceCases_array',
      });
      return null;
    }

    // Build the production golden trace from the Artificer cases. This is the
    // trace that gets ENFORCED at runtime — distinct from the adversarial
    // replay trace used to TEST the code in PRI-426. buildGoldenTraceFromArtificer
    // validates each case structurally (Runtime Rule 4) and requires ≥1 positive
    // + ≥1 negative case.
    const traceBuild = buildGoldenTraceFromArtificer({
      cases: goldenTraceCases,
      sourceArtifactId: assemblyInput.sourceArtificerArtifactId ?? undefined,
    });
    if (!traceBuild.ok) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: `golden_trace_build_failed: ${traceBuild.reason}`,
        nextAction: 'verify_artificer_emitted_valid_positive_plus_negative_cases',
      });
      return null;
    }

    // affectedTools: optional array. Validate element types (Runtime Rule 4) —
    // do not trust the upstream shape. Default to [] when absent/malformed.
    const validatedAffectedTools = Array.isArray(affectedTools)
      ? affectedTools.filter((t): t is string => typeof t === 'string')
      : [];

    const ruleContent = {
      implementationCode,
      goldenTrace: traceBuild.trace,
      goldenTraceCases,
      affectedTools: validatedAffectedTools,
      // adversarialResult.passed === true is the precondition for this method;
      // the gate decision is therefore accepted_shadow.
      ruleHostGateDecision: 'accepted_shadow',
      sourceArtificerArtifactId: assemblyInput.sourceArtificerArtifactId ?? output.sourceArtificerArtifactId,
      adversarialResult: output.adversarialResult,
      ...(requiresContextVersion === 2 ? { requiresContextVersion } : {}),
      // PRI-490: preserve evidenceRefs from Artificer artifact into rule artifact.
      // Only include when the array is valid (non-empty strings) — v1 rules may omit.
      ...(requiresContextVersion === 2 && Array.isArray(evidenceRefs) && evidenceRefs.every((e: unknown) => typeof e === 'string' && e.trim() !== '')
        ? { evidenceRefs: evidenceRefs as string[] }
        : {}),
    };

    // P1 #7 (cross-package acceptance test discovery): resolve the scribe
    // principle artifact and carry forward its principle ID as
    // sourcePrincipleId on the rule artifact. Without this, extractPrincipleId()
    // in the activation dispatcher returns null for rule artifacts, causing
    // activateArtifact() to fail with 'invalid_artifact'/'no_principle_id'.
    // The rule artifact must carry lineage to the principle it enforces.
    let resolvedSourcePrincipleId: string | undefined;
    try {
      const principleBearerId = await this.resolvePrincipleBearerArtifact(output, taskId);
      if (principleBearerId) {
        const principleArtifact = await this.artifactStore.getArtifactById(principleBearerId);
        if (principleArtifact) {
          resolvedSourcePrincipleId = EvaluatorRunner.extractPrincipleIdFromArtifact(principleArtifact);
        }
      }
    } catch (resolveErr) {
      // Fail this optional rule path explicitly below while preserving the
      // already-written principle artifact and prompt-channel fallback.
      this.emitEvent('rule_principle_id_resolve_failed', taskId, {
        runId,
        reason: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
        nextAction: 'verify_scribe_artifact_lineage',
      });
    }

    if (!resolvedSourcePrincipleId) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: 'sourcePrincipleId_unresolved',
        nextAction: 'verify_scribe_artifact_lineage_before_enqueuing_rule_approval',
      });
      return null;
    }

    const ruleArtifactId = `pi-rule-${taskId}-${runId}`;
    const ruleId = `rule-${taskId}`;
    const nowIso = new Date().toISOString();
    try {
      await this.artifactStore.upsertArtifact({
        artifactId: ruleArtifactId,
        artifactKind: 'rule',
        sourceTaskId: taskId,
        sourcePrincipleId: resolvedSourcePrincipleId,
        sourceRuleId: ruleId,
        lineageArtifactIds: [...lineageArtifactIds],
        validationStatus: 'pending',
        contentJson: JSON.stringify(ruleContent),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } catch (writeErr) {
      // PRD Decision 5 degradation: assembly write failure → principle artifact
      // already written, prompt channel usable. Do NOT crash the runner.
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: `artifact_write_failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        nextAction: 'prompt_channel_fallback_available',
      });
      return null;
    }

    // Mark the fully traceable rule validated so RuleHostWriter can activate it.
    try {
      const updated = await this.artifactStore.updateValidationStatus(ruleArtifactId, 'validated');
      if (!updated) {
        this.emitEvent('rule_assembly_failed', taskId, {
          runId,
          reason: 'updateValidationStatus_returned_false',
          ruleArtifactId,
          nextAction: 'verify_artifact_store_consistency',
        });
        return null;
      }
    } catch (updateErr) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: `updateValidationStatus_threw: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
        ruleArtifactId,
        nextAction: 'verify_artifact_store_consistency',
      });
      return null;
    }

    this.emitEvent('rule_assembled', taskId, {
      runId,
      artifactId: ruleArtifactId,
      affectedTools: validatedAffectedTools,
      traceCaseCount: traceBuild.trace.cases.length,
    });
    return ruleArtifactId;
  }

  // ── Evaluator-specific: principle bearer resolution ─────────────────────────

  /**
   * Resolve the principle-bearing artifact that the evaluator should validate.
   *
   * Strategy 1: Use scribeArtifactId from sourceTrace (the Scribe artifact
   * carries principleDraft).
   * Strategy 2: Search lineage for principle-kind artifacts with principleDraft.
   * Strategy 3: No principle-bearing artifact found → telemetry, return null.
   *
   * Ambiguous candidates (more than 1) → fail loud with telemetry, return null.
   * Never silently pick the first candidate (ERR-018, ERR-019).
   */
  private async resolvePrincipleBearerArtifact(
    output: EvaluatorOutputV1,
    taskId: string,
  ): Promise<string | null> {
    // Strategy 1: Use scribeArtifactId from sourceTrace
    const scribeArtifactId = output.sourceTrace?.scribeArtifactId;
    if (typeof scribeArtifactId === 'string' && scribeArtifactId.trim() !== '') {
      const scribeArtifact = await this.artifactStore.getArtifactById(scribeArtifactId);
      if (scribeArtifact && scribeArtifact.artifactKind === 'principle') {
        return scribeArtifactId;
      }
      // Scribe artifact not found or wrong kind — fall through to lineage search
      this.emitEvent('scribe_artifact_not_principle', taskId, {
        scribeArtifactId,
        actualKind: scribeArtifact?.artifactKind ?? 'not_found',
      });
    }

    // Strategy 2: Search lineage for all principle-kind artifacts with principleDraft content
    const { ids: lineageArtifactIds } = await this.resolveLineageArtifactIds(taskId);
    const candidates: string[] = [];
    for (const lineageId of lineageArtifactIds) {
      const artifact = await this.artifactStore.getArtifactById(lineageId);
      if (!artifact) continue;
      if (artifact.artifactKind !== 'principle') continue;
      if (this.hasPrincipleDraftContent(artifact.contentJson)) {
        candidates.push(lineageId);
      }
    }

    // Strategy 2b: Transitive lineage search. The evaluator's direct dependency
    // is the artificer task; the scribe task (which carries the principleDraft)
    // is a transitive dependency (evaluator → artificer → scribe). When direct
    // lineage has no principle-bearing artifact, traverse one level deeper by
    // resolving each direct-lineage artifact's source task and searching ITS
    // dependencies. This is bounded to depth 2 to prevent unbounded traversal.
    if (candidates.length === 0 && lineageArtifactIds.length > 0) {
      const transitiveCandidates = await this.resolveTransitivePrincipleCandidates(taskId, lineageArtifactIds);
      candidates.push(...transitiveCandidates);
    }

    if (candidates.length === 1) {
      const [only] = candidates;
      return only ?? null;
    }

    if (candidates.length > 1) {
      // Ambiguous — fail loud, do NOT silently pick first (ERR-018)
      this.emitEvent('principle_bearer_ambiguous', taskId, {
        candidateArtifactIds: candidates,
        reason: 'multiple_principle_bearing_artifacts_in_lineage',
        nextAction: 'disambiguate_principle_source_or_fix_lineage',
      });
      return null;
    }

    // Strategy 3: No principle-bearing artifact found
    this.emitEvent('no_principle_bearer_found', taskId, {
      runId: output.taskId,
      scribeArtifactId: scribeArtifactId ?? 'not_provided',
      lineageCount: lineageArtifactIds.length,
      reason: 'no_principle_bearing_artifact_in_lineage',
      nextAction: 'verify_scribe_artifact_exists_and_has_principle_draft',
    });
    return null;
  }

  /**
   * Check if an artifact's contentJson contains principle-bearing content.
   * Uses Object.hasOwn (ERR-013) and runtime type checks (ERR-001, ERR-005).
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private hasPrincipleDraftContent(contentJson: string): boolean {
    try {
      const parsed: unknown = JSON.parse(contentJson);
      if (!EvaluatorRunner.isRecord(parsed)) return false;
      // Check for principleDraft.title + principleDraft.statement
      if (Object.hasOwn(parsed, 'principleDraft')) {
        const draft = parsed.principleDraft;
        if (EvaluatorRunner.isRecord(draft)
          && Object.hasOwn(draft, 'title') && typeof draft.title === 'string' && draft.title.trim() !== ''
          && Object.hasOwn(draft, 'statement') && typeof draft.statement === 'string' && draft.statement.trim() !== '') {
          return true;
        }
      }
      // Check for principleId + text (alternative principle format)
      if (Object.hasOwn(parsed, 'principleId') && typeof parsed.principleId === 'string' && parsed.principleId.trim() !== ''
        && Object.hasOwn(parsed, 'text') && typeof parsed.text === 'string' && parsed.text.trim() !== '') {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * Resolve principle-bearing artifacts from transitive lineage (depth 2).
   *
   * For each direct-lineage artifact, resolve its source task's dependencies
   * and search those artifacts for principle-kind artifacts with principleDraft
   * content. This handles the common case where the evaluator's direct
   * dependency is the artificer, and the scribe (principle-bearer) is a
   * transitive dependency (evaluator → artificer → scribe).
   *
   * Bounded to depth 2 to prevent unbounded traversal. Cycle-safe via the
   * visited set.
   */
  private async resolveTransitivePrincipleCandidates(
    evaluatorTaskId: string,
    directLineageArtifactIds: string[],
  ): Promise<string[]> {
    const candidates: string[] = [];
    const visited = new Set<string>([evaluatorTaskId]);

    for (const artifactId of directLineageArtifactIds) {
      if (visited.has(artifactId)) continue;
      visited.add(artifactId);

      const artifact = await this.artifactStore.getArtifactById(artifactId);
      if (!artifact) continue;

      // Resolve the source task's dependencies (one level deeper)
      const { ids: deeperLineageIds } = await this.resolveLineageArtifactIds(artifact.sourceTaskId);
      for (const deeperId of deeperLineageIds) {
        if (visited.has(deeperId)) continue;
        visited.add(deeperId);

        const deeperArtifact = await this.artifactStore.getArtifactById(deeperId);
        if (!deeperArtifact) continue;
        if (deeperArtifact.artifactKind !== 'principle') continue;
        if (this.hasPrincipleDraftContent(deeperArtifact.contentJson)) {
          candidates.push(deeperId);
        }
      }
    }

    return candidates;
  }
}
