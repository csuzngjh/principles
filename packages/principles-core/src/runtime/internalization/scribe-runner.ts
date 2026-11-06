/**
 * ScribeRunner — Third peer runner for the Internalization Engine (PRI-109).
 *
 * Migrated to extend BasePeerRunner (PRI-302). The shared lease → buildContext →
 * invoke → poll → fetch → validate → succeed/fail pipeline is now in the base
 * class. This file only contains Scribe-specific logic.
 *
 * Key constraints (ADR-0003):
 *   - Uses PDRuntimeAdapter for all LLM execution (no direct SDK calls)
 *   - Does NOT directly invoke Artificer (host layer enqueues next task)
 *   - No plugin-layer imports (core is infrastructure-agnostic)
 *   - No timer-based scheduling (sleep via setTimeout is polling-only)
 *   - Uses RuntimeStateManager for all state operations
 *
 * Pipeline:
 *   1. acquireLease — isolated try/catch, lease_conflict is non-mutating
 *   2. resolve Philosopher dependency from dependencyTaskIds
 *   3. fetch Philosopher artifact via PIArtifactStore
 *   4. startRun with outputSchemaRef: 'scribe-output-v1'
 *   5. pollUntilTerminal
 *   6. fetchOutput → validate as unknown → cast to ScribeOutputV1
 *   7. updateRunOutput → persist serialized output
 *   8. write PIArtifact → markTaskSucceeded with scribe:// resultRef
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 * @see BasePeerRunner in runner/base-peer-runner.ts
 */
import type { CandidatePrincipleIdentityResolution } from '../adapter/principle-tree-ledger-adapter.js';
import type { CandidateIdentityPort } from './candidate-identity.js';
import type { RunHandle } from '../runtime-protocol.js';
import type { ScribeOutputV1, ScribeValidator } from './scribe-output.js';
import { normalizeStringEncodedIntentContract } from './scribe-output.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory, isPDErrorCategory } from '../error-categories.js';
import { hydratePITaskRecord, isFreshForNextAttempt, parseLastValidatorErrors, parseSeedSourcePainId, type LastValidatorErrors } from './pitask-metadata.js';
import { ScribePromptBuilder } from './scribe-prompt-builder.js';
import { resolveFormationContext } from './formation-context.js';
import type { FormationContext, FormationTaskView } from './formation-context.js';
import { collectUpstreamNormalisedText } from './artificer-intent-preflight.js';
import { reconcileLineageEcho } from './peer-runner-contracts.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import {
  candidateIdFromDreamerSeed,
  candidateIdFromDreamerTaskId,
} from '../activation/ledger-identity.js';
import type {
  PeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../runner/peer-runner-types.js';
import type { OutputLanguage } from '../language-directive.js';
import { validateCandidateIdentityReceipt } from '../principle-tree/rule-candidate-binding.js';

// ── Scribe-specific context ──────────────────────────────────────────────────

/** Context built by ScribeRunner.buildContext() and consumed by invokeRuntime(). */
interface ScribeContext {
  readonly identityAtStart?: CandidatePrincipleIdentityResolution;
  readonly contextHash: string;
  readonly philosopherArtifact: string;
  readonly sourcePhilosopherArtifactId: string;
  /**
   * PRI-816 (R-01): authoritative dreamer artifact id extracted from the
   * philosopher artifact's `sourceDreamerArtifactId`. Optional — absent on
   * pre-PRI-508 philosopher artifacts, where the scribe keeps emitting no
   * `sourceTrace.dreamerArtifactId` (backward compatible).
   */
  readonly sourceDreamerArtifactId?: string;
  /**
   * PRI-838: bounded projection of the formation evidence this formation was
   * built from — the dreamer's full (bounded) proposal set, the source
   * diagnosis, and provenance. Optional: undefined when the dreamer artifact
   * could not be resolved, in which case the prompt keeps its pre-PRI-838
   * shape exactly (legacy / degraded compatibility).
   */
  readonly formationContext?: FormationContext;
  /**
   * PRI-1047 修复 A: 上一次 attempt 的 validator 拒绝全文（读取侧已做信任
   * 边界验证 + 限界）。仅在新鲜度判定通过（sourceAttemptCount === 当前
   * attempt-1，isFreshForNextAttempt）时由 buildContext 携带——修复 attempt
   * 的 prompt 不再与首轮零差异重试。Ephemeral，不回写。
   */
  readonly priorValidatorErrors?: LastValidatorErrors;
  /** SPEC-PRI-1047: 已解析的 philosopher 依赖任务 id（validateOutput 复用 preflight 同口径上游材料走查）。 */
  readonly philosopherTaskId?: string;
  /** SPEC-PRI-1047: 任务的权威通道（intake bridge 写入；validateOutput 只对 code_tool_hook 施加锚定）。 */
  readonly channel?: string | null;
}

/**
 * PRI-816 (R-01): extract the authoritative dreamer artifact id from the
 * philosopher artifact content (rc-1: content is untrusted). Access uses
 * `Reflect.get` + a runtime type guard — no `as` cast, per the rc-2 contract
 * this PR claims. Returns undefined when absent or malformed; the scribe
 * then simply omits `sourceTrace.dreamerArtifactId` (pre-PRI-508 compatible).
 */
function extractSourceDreamerArtifactId(philosopherContentJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(philosopherContentJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  if (!Object.hasOwn(parsed, 'sourceDreamerArtifactId')) return undefined;
  const value = Reflect.get(parsed, 'sourceDreamerArtifactId');
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value;
}

// ── Result Types (backward-compatible exports) ───────────────────────────────

export type ScribeRunnerResultStatus = 'succeeded' | 'failed' | 'retried';

export interface ScribeRunnerResult {
  readonly status: ScribeRunnerResultStatus;
  readonly taskId: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly resultRef?: string;
  readonly contextHash?: string;
  readonly output?: ScribeOutputV1;
  readonly errorCategory?: PDErrorCategory;
  readonly failureReason?: string;
  readonly attemptCount: number;
}

// ── Constructor Options (backward-compatible exports) ────────────────────────

export type ScribeRunnerOptions = PeerRunnerOptions;

export interface ResolvedScribeRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
  /** Owner's preferred language for principle generation (PRI-336). Undefined = no directive. */
  readonly outputLanguage?: OutputLanguage;
  /** Whether to inject CORE_PRINCIPLES into the scribe prompt (default: true). */
  readonly coreGrounding: boolean;
}

export const DEFAULT_SCRIBE_RUNNER_OPTIONS: Readonly<Omit<ResolvedScribeRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'scribe',
  coreGrounding: true,
} as const;

export function resolveScribeRunnerOptions(options: ScribeRunnerOptions): ResolvedScribeRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_SCRIBE_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_SCRIBE_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_SCRIBE_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? DEFAULT_SCRIBE_RUNNER_OPTIONS.agentId,
    outputLanguage: options.outputLanguage,
    coreGrounding: options.coreGrounding ?? DEFAULT_SCRIBE_RUNNER_OPTIONS.coreGrounding,
  };
}

// ── Dependencies (backward-compatible; extends PeerRunnerDeps) ───────────────

export interface ScribeRunnerDeps extends PeerRunnerDeps {
  readonly validator: ScribeValidator;
  /**
   * I2 — CHAIN STAMPING (Phase 3 Option A′, §6 of
   * docs/architecture/principle-identity-reconciliation.md; Owner review of
   * PR #1856 P1: the activation gate must not cut the live chain).
   *
   * When provided, ScribeRunner stamps the ledger principle identity onto the
   * artifact it writes: scribe context carries the dreamer artifact id, whose
   * task seed carries the candidateId, which the ledger maps back to the
   * principle minted at intake. Stamping is fail-soft — an unresolvable chain
   * writes the artifact unstamped and emits an observable event; the
   * activation boundary then either resolves the identity from lineage or
   * refuses. Ambiguity (0 or >1 ledger matches) is never guessed.
   *
   * PRI-915: `isAvailable` separates an unreadable ledger (transient outage,
   * surfaced in the skip event reason) from a genuinely unresolved chain.
   */
  readonly ledgerIdentity?: Partial<CandidateIdentityPort> & {
    readonly isAvailable: () => boolean;
    readonly listForCandidate: (candidateId: string) => readonly { readonly id: string }[];
  };
}

// ── ScribeRunner ─────────────────────────────────────────────────────────────

export class ScribeRunner extends BasePeerRunner<ScribeContext, ScribeOutputV1> {
  private readonly validator: ScribeValidator;
  private readonly ledgerIdentity?: ScribeRunnerDeps['ledgerIdentity'];

  constructor(deps: ScribeRunnerDeps, options: PeerRunnerOptions) {
    super(deps, options, {
      runnerName: 'scribe',
      expectedTaskKind: 'scribe',
      defaultAgentId: 'scribe',
      resultRefPrefix: 'scribe',
    });
    this.validator = deps.validator;
    this.ledgerIdentity = deps.ledgerIdentity;
  }

  /** Identity absence awaits Owner action and consumes no model attempt. */
  override async run(taskId: string): Promise<PeerRunnerResult<ScribeOutputV1>> {
    if (this.ledgerIdentity?.resolveForCandidate) {
      const task = await this.stateManager.getTask(taskId);
      if (task && (task.status === 'pending' || task.status === 'retry_wait') && hydratePITaskRecord(task)?.channel === 'code_tool_hook') {
        let identity: CandidatePrincipleIdentityResolution | undefined;
        try {
          // buildContext already resolves identityAtStart for this port;
          // reusing it avoids a second artifact/task/ledger resolution pass.
          identity = (await this.buildContext(taskId)).identityAtStart;
        } catch {
          // Context problems belong to the base runner's state machine, which
          // owns lease acquisition and failure/retry transitions.
          return super.run(taskId);
        }
        if (identity && identity.status !== 'resolved') {
          const reason = identity.reason === 'ledger_unavailable' ? 'identity_source_unavailable' : 'awaiting_owner_binding';
          const diagnostic: unknown = task.diagnosticJson ? JSON.parse(task.diagnosticJson) : {};
          const metadata = diagnostic !== null && typeof diagnostic === 'object' && !Array.isArray(diagnostic) ? diagnostic : {};
          await this.stateManager.updateTaskIfDiagnosticJsonUnchanged(taskId, task.diagnosticJson ?? null, {
            status: 'needs_human_review',
            diagnosticJson: JSON.stringify({ ...metadata, identityPreflight: { reason, detail: identity.reason, nextAction: identity.nextAction } }),
          }, { expectedStatus: task.status, expectedLeaseOwner: null, expectedLeaseExpiresAt: null });
          this.emitEvent('identity_preflight_blocked', taskId, { reason, detail: identity.reason, modelRequests: 0 });
          return { status: 'failed', taskId, errorCategory: 'input_invalid', failureReason: `${reason}:${identity.reason}`, attemptCount: task.attemptCount };
        }
      }
    }
    return super.run(taskId);
  }

  private async resolveCurrentIdentity(context: ScribeContext): Promise<CandidatePrincipleIdentityResolution> {
    const dreamer = context.sourceDreamerArtifactId ? await this.artifactStore.getArtifactById(context.sourceDreamerArtifactId) : null;
    const task = dreamer?.sourceTaskId ? await this.stateManager.getTask(dreamer.sourceTaskId) : null;
    const candidateId = candidateIdFromDreamerSeed(task?.diagnosticJson) ?? candidateIdFromDreamerTaskId(dreamer?.sourceTaskId);
    if (!candidateId || !this.ledgerIdentity?.resolveForCandidate) return { status: 'unresolved', reason: 'candidate_missing', nextAction: 'Inspect the persisted dreamer lineage.' };
    return this.ledgerIdentity.resolveForCandidate(candidateId);
  }

  // ── Abstract implementations ───────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid']);
  }

  async buildContext(taskId: string): Promise<ScribeContext> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    if (deps.length === 0) {
      throw new PDRuntimeError('input_invalid', 'Philosopher dependency artifact not found');
    }

    for (const depId of deps) {
      const depTask = await this.stateManager.getTask(depId);
      if (!depTask) continue;
      if (depTask.taskKind !== 'philosopher') continue;
      if (depTask.status !== 'succeeded') {
        this.emitEvent('dependency_not_succeeded', taskId, {
          depTaskId: depId,
          depStatus: depTask.status,
        });
        continue;
      }

      const depPiTask = hydratePITaskRecord(depTask);
      const artifacts = await this.artifactStore.listBySourceTaskId(depId);
      if (artifacts.length > 0) {
        const [firstArtifact] = artifacts;
        if (!firstArtifact) continue;
        const artifactRef = depPiTask?.outputArtifactRefs?.[0]?.ref ?? `pi-artifact://${depId}`;
        // PRI-816 (R-01): authoritative dreamer lineage, extracted from the
        // philosopher artifact's own `sourceDreamerArtifactId` (a required
        // field of philosopher-output-v1). The scribe prompt copies this
        // into `sourceTrace.dreamerArtifactId` instead of scraping artifact
        // content with a mismatched field name.
        const sourceDreamerArtifactId = extractSourceDreamerArtifactId(firstArtifact.contentJson);

        // PRI-838 (DC-1): resolve the formation evidence the id above points
        // at. Before this, the scribe held the identifier and never dereferenced
        // it — the source pain, the diagnosis and the dreamer's alternatives
        // were structurally dropped. Best-effort and never blocking: an
        // unresolvable formation yields `undefined` and the prompt keeps its
        // pre-PRI-838 shape. rc-9: every degradation emits an observable event.
        const formationContext = await resolveFormationContext({
          sourceDreamerArtifactId,
          artifactStore: this.artifactStore,
          lookupTask: (id) => this.lookupFormationTask(id),
          emitEvent: (eventName, eventTaskId, payload) => this.emitEvent(eventName, eventTaskId, payload),
          taskId,
        });

        // The context hash now covers the evidence the prompt actually carries,
        // matching what dreamer-runner already does for its own predecessors.
        const contextRefs = [
          artifactRef,
          ...(formationContext !== undefined
            ? [
                formationContext.provenance.sourceDreamerArtifactId,
                ...(formationContext.provenance.sourceDiagnosisArtifactId !== null
                  ? [formationContext.provenance.sourceDiagnosisArtifactId]
                  : []),
              ]
            : []),
        ];

        // PRI-1047 修复 A: 携带新鲜的上一轮 validator 拒绝（镜像
        // ArtificerRunner 的 priorValidatorErrors 消费模式）。
        const priorValidatorErrors = this.readFreshPriorValidatorErrors(taskId, task);
        const context: ScribeContext = {
          contextHash: BasePeerRunner.hashContextRefs(contextRefs),
          philosopherArtifact: firstArtifact.contentJson,
          sourcePhilosopherArtifactId: firstArtifact.artifactId,
          sourceDreamerArtifactId,
          ...(formationContext !== undefined ? { formationContext } : {}),
          philosopherTaskId: depId,
          channel: piTask?.channel ?? null,
          ...(priorValidatorErrors !== undefined ? { priorValidatorErrors } : {}),
        };
        return this.ledgerIdentity?.resolveForCandidate
          ? { ...context, identityAtStart: await this.resolveCurrentIdentity(context) } : context;
      }
    }

    throw new PDRuntimeError('input_invalid', 'Philosopher dependency artifact not found');
  }

  /**
   * PRI-838: narrow task view for formation-context resolution.
   *
   * Phase identity exists ONLY on the task row — every PI artifact is written
   * with `artifact_kind = 'principle'`, so the diagnostic predecessor cannot be
   * identified from artifact records alone (see formation-context.ts).
   */
  private async lookupFormationTask(taskId: string): Promise<FormationTaskView | null> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) return null;
    return {
      taskKind: task.taskKind,
      status: task.status,
      dependencyTaskIds: hydratePITaskRecord(task)?.dependencyTaskIds ?? [],
    };
  }

  /**
   * PRI-1047 修复 A: 读取上一 attempt 的 lastValidatorErrors 并做新鲜度
   * 判定（isFreshForNextAttempt，sourceAttemptCount === 当前 leased attempt-1）。
   * 陈旧/缺 lease 时不回喂，仅发一个 suppression 事件（rc-9）——跨 epoch
   * （reopen 后 attemptCount 归零）旧错误永不混入新轮（rc-7）。
   */
  private readFreshPriorValidatorErrors(taskId: string, task: TaskRecord): LastValidatorErrors | undefined {
    const record = parseLastValidatorErrors(task.diagnosticJson);
    if (record === null) return undefined;
    if (!isFreshForNextAttempt(record, this.currentLeasedAttempt)) {
      this.emitEvent('prior_validator_errors_suppressed', taskId, {
        recordedAt: record.recordedAt,
        errorCount: record.errors.length,
        sourceAttemptCount: record.sourceAttemptCount,
        currentAttempt: this.currentLeasedAttempt,
        reason: this.currentLeasedAttempt === undefined
          ? 'no_lease_context'
          : 'stale_for_current_attempt',
      });
      return undefined;
    }
    return record;
  }

  /**
   * SPEC-PRI-1047 修复 A: 与 artificer intent preflight 完全同口径的上游
   * 材料解析（collectUpstreamNormalisedText：philosopher 意图字段 + PRI-1018
   * formation 诊断 evidence notes，含 philosopher↔scribe dreamer 血缘与
   * pain lineage 校验）。读取失败/不可解析 → 返回 undefined 并发事件
   * （rc-9），锚定检查降级由 preflight 既有停点兜底。
   */
  private async resolveUpstreamAnchorMaterial(taskId: string, context: ScribeContext, candidateOutput: unknown): Promise<{ normalisedText: string } | null | undefined> {
    if (context.philosopherTaskId === undefined) return undefined;
    let material: { normalisedText: string } | null;
    try {
      material = await collectUpstreamNormalisedText(
        async (depId: string) => this.stateManager.getTask(depId),
        (sourceTaskId: string) => this.artifactStore.listBySourceTaskId(sourceTaskId),
        {
          scribeDependencyTaskIds: [context.philosopherTaskId],
          formationSource: {
            scribeContentJson: JSON.stringify(candidateOutput),
            artifactStore: this.artifactStore,
            lookupTask: async (formationTaskId) => {
              const task = await this.stateManager.getTask(formationTaskId);
              if (!task) return null;
              const hydrated = hydratePITaskRecord(task);
              return {
                taskKind: task.taskKind,
                status: task.status,
                dependencyTaskIds: hydrated?.dependencyTaskIds ?? [],
                canonicalSourcePainId: parseSeedSourcePainId(task.diagnosticJson),
              };
            },
            taskId,
          },
        },
      );
    } catch (error: unknown) {
      this.emitEvent('anchor_material_unavailable', taskId, {
        reason: 'upstream_material_read_failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    // rc-9（SPEC §3.2）：collectUpstreamNormalisedText 返回 null 的每一种
    // 不可解析形态（philosopher 工件损坏 / dreamer 血缘错配 / pain 血缘
    // 错配 / 空材料池）同样发事件——锚定降级必须可观测，不能只在抛错时可见。
    if (material === null) {
      this.emitEvent('anchor_material_unavailable', taskId, {
        reason: 'upstream_material_unresolvable',
      });
    }
    return material;
  }

  async invokeRuntime(taskId: string, context: ScribeContext): Promise<RunHandle> {
    const {coreGrounding} = this.resolvedOptions;

    let parsedPhilosopherArtifact: unknown;
    try {
      parsedPhilosopherArtifact = JSON.parse(context.philosopherArtifact);
    } catch {
      parsedPhilosopherArtifact = context.philosopherArtifact;
    }

    const builder = new ScribePromptBuilder({ coreGrounding, outputLanguage: this.resolvedOptions.outputLanguage });
    const { message, systemPrompt } = builder.buildPrompt({
      taskId,
      contextHash: context.contextHash,
      philosopherArtifact: parsedPhilosopherArtifact,
      sourcePhilosopherArtifactId: context.sourcePhilosopherArtifactId,
      ...(context.sourceDreamerArtifactId !== undefined
        ? { sourceDreamerArtifactId: context.sourceDreamerArtifactId }
        : {}),
      // PRI-838: formation evidence (dreamer proposals + source diagnosis +
      // provenance) rides in the payload; the addendum that assigns it priority
      // is appended to the system prompt by the builder.
      ...(context.formationContext !== undefined ? { formationContext: context.formationContext } : {}),
      outputLanguage: this.resolvedOptions.outputLanguage,
      coreGrounding,
    });

    // Rollout needs_revision 修订轮反馈 (P0-E): 任务元数据带 revisionFeedback 时
    // 注入 prompt,让 scribe 针对性修订而非盲目重写。缺失 = 首轮,行为不变。
    const revisionFeedback = await this.resolveRevisionFeedback(taskId);
    // PRI-1047 修复 A: 新鲜的上一轮 validator 拒绝全文回喂（字段级锚定/
    // 结构错误），修复 attempt 不再与首轮零差异重试（EP-05）。
    const priorErrorsBlock = context.priorValidatorErrors !== undefined
      ? `\n\n<previous_validation_errors>\nYour previous attempt was REJECTED by the deterministic validator with these exact errors (fix every one of them; the same material is re-checked):\n${context.priorValidatorErrors.errors.map((error) => `- ${error}`).join('\n')}\n</previous_validation_errors>`
      : '';
    const finalMessage = revisionFeedback
      ? `${message}\n\n<revision_feedback>\n${revisionFeedback}\n</revision_feedback>${priorErrorsBlock}`
      : `${message}${priorErrorsBlock}`;

    return this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: finalMessage,
      contextItems: [],
      outputSchemaRef: 'scribe-output-v1',
      timeoutMs: this.resolvedOptions.timeoutMs,
      systemPrompt,
    });
  }

  /** 修订轮反馈 (P0-E): 读取任务元数据 revisionFeedback, 缺失返回 null */
  private async resolveRevisionFeedback(taskId: string): Promise<string | null> {
    try {
      const task = await this.stateManager.getTask(taskId);
      if (!task) return null;
      const piTask = hydratePITaskRecord(task);
      const feedback = piTask?.revisionFeedback;
      return typeof feedback === 'string' && feedback.trim() !== '' ? feedback : null;
    } catch {
      return null; // 反馈读取失败不阻断首轮语义 (rc-9: 修订路由已有事件记录)
    }
  }

  async validateOutput(output: unknown, taskId: string, context: ScribeContext): Promise<PeerRunnerValidationResult> {
    // SPEC-PRI-1047 修复 A: code_tool_hook 渠道在成功边界前用与 preflight
    // 同口径的上游材料执行锚定检查——错误引用不能先被标成功。上游材料
    // 不可解析时降级跳过（事件可观测），preflight 既有停点兜底。
    let anchoring: { upstreamAnchorMaterial?: { normalisedText: string } | null } | undefined;
    if (context.channel === 'code_tool_hook') {
      const upstream = await this.resolveUpstreamAnchorMaterial(taskId, context, output);
      anchoring = { upstreamAnchorMaterial: upstream ?? null };
    }
    const result = await this.validator.validate(output, taskId, context.sourcePhilosopherArtifactId, anchoring);

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

  /**
   * PRI-1047 修复 A: 成功后的清理——任务成功时定点删除 diagnosticJson 顶层
   * lastValidatorErrors 键（不再把上一轮拒绝留在已成功任务上；新鲜度判定
   * 本已屏蔽，这是显式清理要求）。CAS 失败仅发事件、不阻断成功（rc-9；
   * 读取侧 sourceAttemptCount 新鲜度仍是正确性兜底）。
   */
  private async clearLastValidatorErrorsOnSuccess(taskId: string, task: TaskRecord): Promise<void> {
    if (task.diagnosticJson === null || task.diagnosticJson === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(task.diagnosticJson);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    if (!Object.hasOwn(parsed, 'lastValidatorErrors')) return;
    Reflect.deleteProperty(parsed, 'lastValidatorErrors');
    const updated = await this.stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId,
      task.diagnosticJson,
      { diagnosticJson: JSON.stringify(parsed) },
    );
    if (!updated) {
      this.emitEvent('last_validator_errors_cleanup_conflict', taskId, {
        reason: 'cas_lost_to_concurrent_writer',
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/max-params
  async succeedTask(
    taskId: string,
    runId: string,
    output: ScribeOutputV1,
    task: TaskRecord,
    contextHash: string,
    context: ScribeContext,
  ): Promise<PeerRunnerResult<ScribeOutputV1>> {
    // Lineage consistency: sourcePhilosopherArtifactId must match buildContext result (ERR-004).
    if (output.sourcePhilosopherArtifactId !== context.sourcePhilosopherArtifactId) {
      throw new PDRuntimeError(
        'output_invalid',
        `sourcePhilosopherArtifactId mismatch: expected ${context.sourcePhilosopherArtifactId}, got ${output.sourcePhilosopherArtifactId}`,
      );
    }

    // PRI-1047 修复 A: 成功后清理上一轮 validator 拒绝记录。
    await this.clearLastValidatorErrorsOnSuccess(taskId, task);

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

    // I2 — CHAIN STAMPING (fail-soft): resolve the ledger principle id from
    // the scribe → dreamer artifact → dreamer task seed (candidateId) → ledger
    // chain and stamp it onto the artifact. Unresolvable/ambiguous chains
    // write the artifact unstamped with an observable event — the activation
    // boundary then refuses or resolves from lineage; never a guess.
    let stampedPrincipleId: string | null = null;
    const identity = this.ledgerIdentity?.resolveForCandidate ? await this.resolveCurrentIdentity(context) : null;
    // These terminal identity refusals bypass the base runner's mark-failed
    // path, so the attempt lease must be released here: a lingering lease
    // would keep the Owner's bounded binding revision (reviseRuleBindingOnce)
    // refused with task_lease_present forever.
    const parkForOwnerIdentityAction = async (reason: string, nextAction: string): Promise<PeerRunnerResult<ScribeOutputV1>> => {
      await this.stateManager.updateTask(taskId, { status: 'needs_human_review', leaseOwner: null, leaseExpiresAt: null });
      this.emitEvent('identity_preflight_blocked', taskId, { reason, nextAction });
      return { status: 'failed', taskId, errorCategory: 'input_invalid', failureReason: reason, attemptCount: task.attemptCount };
    };
    if (identity?.status === 'resolved' && hydratePITaskRecord(task)?.channel === 'code_tool_hook'
      && !validateCandidateIdentityReceipt(context.identityAtStart, identity)) {
      return parkForOwnerIdentityAction('identity_changed_during_generation', 'review_binding_and_preserve_the_current_revision_budget');
    }
    if (identity && identity.status !== 'resolved' && hydratePITaskRecord(task)?.channel === 'code_tool_hook') {
      return parkForOwnerIdentityAction(identity.reason, identity.nextAction);
    }
    const receipt = identity?.status === 'resolved' ? {
      candidateId: identity.candidateId, basis: identity.basis, principleId: identity.principleId,
      ...(identity.bindingRevision !== undefined ? { bindingRevision: identity.bindingRevision } : {}),
      ...(identity.decisionId !== undefined ? { decisionId: identity.decisionId } : {}),
    } : undefined;
    if (this.ledgerIdentity) {
      try {
        stampedPrincipleId = identity?.status === 'resolved' ? identity.principleId : await this.resolveLedgerStampPrincipleId(context);
      } catch (stampErr) {
        this.emitEvent('identity_stamp_failed', taskId, {
          runId,
          errorMessage: stampErr instanceof Error ? stampErr.message : String(stampErr),
        });
      }
      if (stampedPrincipleId === null) {
        // PRI-915: an unreadable ledger collapses listForCandidate to `[]`;
        // that skip is a transient outage, not an unresolvable chain — say so
        // instead of reporting the generic skip reason.
        const ledgerUnavailable = !this.ledgerIdentity.isAvailable();
        this.emitEvent('identity_stamp_skipped', taskId, {
          runId,
          reason: ledgerUnavailable
            ? 'ledger_unavailable: the principle ledger exists but cannot be read; stamping is not decidable right now'
            : 'ledger principle id unresolved from scribe chain (missing dreamer lineage, unreadable seed, or 0/>1 ledger matches)',
        });
      }
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
        ...(stampedPrincipleId !== null ? { sourcePrincipleId: stampedPrincipleId } : {}),
        contentJson: JSON.stringify({ ...output, ...(receipt ? { identityResolution: receipt } : {}) }),
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

    // Mark task succeeded
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
      principleTitle: output.principleDraft.title,
      ...(stampedPrincipleId !== null ? { sourcePrincipleId: stampedPrincipleId } : {}),
    });

    return {
      status: 'succeeded',
      taskId,
      runId,
      artifactId,
      resultRef,
      contextHash,
      output,
      attemptCount: task.attemptCount,
    };
  }

  /**
   * I2 — resolve the ledger principle id for chain stamping.
   *
   * Chain: scribe context's dreamer artifact id → dreamer artifact record →
   * its source task's diagnostic_json (authoritative candidateId, written by
   * intake-to-internalization-bridge) with the task-id spelling
   * (`dreamer-<candidateId>-<channel>`) as fallback → ledger principles
   * derived from that candidate. Exactly one match is required — 0 or >1
   * stays unresolved (never guessed).
   */
  private async resolveLedgerStampPrincipleId(context: ScribeContext): Promise<string | null> {
    const ledger = this.ledgerIdentity;
    if (!ledger) return null;

    // PRI-915: an unreadable ledger collapses listForCandidate to `[]`, but
    // the stamp must not rely on that collapse — while unavailable, the
    // resolution is not decidable, full stop. The caller's skip event then
    // reports ledger_unavailable instead of the generic chain reason.
    if (!ledger.isAvailable()) return null;

    const dreamerArtifactId = context.sourceDreamerArtifactId;
    if (!dreamerArtifactId) return null;

    const dreamerArtifact = await this.artifactStore.getArtifactById(dreamerArtifactId);
    if (!dreamerArtifact) return null;

    let candidateId: string | null = null;
    if (dreamerArtifact.sourceTaskId) {
      try {
        const dreamerTask = await this.stateManager.getTask(dreamerArtifact.sourceTaskId);
        if (dreamerTask) {
          candidateId = candidateIdFromDreamerSeed(dreamerTask.diagnosticJson);
        }
      } catch {
        // Seed read failed — the task-id spelling fallback below still applies.
      }
      candidateId ??= candidateIdFromDreamerTaskId(dreamerArtifact.sourceTaskId);
    }
    if (!candidateId) return null;

    const matches = ledger.listForCandidate(candidateId);
    if (matches.length !== 1) return null;
    return matches[0]?.id ?? null;
  }

  // ── Optional hooks ─────────────────────────────────────────────────────────

  /**
   * Re-inject taskId if stripped by stripLineageFields (PRI-272 / ERR-008).
   * Only fill when absent via Object.hasOwn — present-but-falsy values
   * must reach validation and fail loud (Runtime Contract Rule 3).
   *
   * The generatedAt override is handled by the base class via
   * super.postFetchTransform().
   */
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown, _context: ScribeContext): void {
    super.postFetchTransform(taskId, untrustedOutput, _context);
    // Shared lineage echo gate (PRI-541): reconciles taskId,
    // sourcePhilosopherArtifactId and sourceTrace.philosopherArtifactId
    // against the authoritative context value before validation — a wrong
    // echo previously dead-ended as output_invalid.
    // PRI-816 (R-01): when the context carries an authoritative
    // sourceDreamerArtifactId, `sourceTrace.dreamerArtifactId` is now echo-
    // corrected the same way (a wrong/absent copy used to strand the dreamer
    // lineage: artificer's resolveDreamerContext silently lost the five
    // dreamer dimensions). Without an authoritative value the field stays
    // untouched (pre-PRI-508 flows).
    const dreamerTraceFields =
      _context.sourceDreamerArtifactId !== undefined
        ? [{ field: 'dreamerArtifactId', authoritativeValue: _context.sourceDreamerArtifactId }]
        : [];
    const correctedFields = reconcileLineageEcho(untrustedOutput, {
      topFields: [
        { field: 'taskId', authoritativeValue: taskId },
        { field: 'sourcePhilosopherArtifactId', authoritativeValue: _context.sourcePhilosopherArtifactId },
      ],
      trace: {
        traceField: 'sourceTrace',
        fields: [
          { field: 'philosopherArtifactId', authoritativeValue: _context.sourcePhilosopherArtifactId },
          ...dreamerTraceFields,
        ],
      },
    });
    if (correctedFields.length > 0) {
      this.emitEvent('lineage_echo_corrected', taskId, { correctedFields });
    }
    if (normalizeStringEncodedIntentContract(untrustedOutput)) {
      this.emitEvent('intent_contract_string_normalized', taskId, {});
    }
  }

  protected override emitSuccessTelemetry(taskId: string, output: ScribeOutputV1): void {
    this.emitEvent('principle_draft_generated', taskId, {
      principleTitle: output.principleDraft.title,
    });
  }
}
