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
import type { RunHandle } from '../runtime-protocol.js';
import type { ScribeOutputV1, ScribeValidator } from './scribe-output.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory, isPDErrorCategory } from '../error-categories.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { ScribePromptBuilder } from './scribe-prompt-builder.js';
import { SCRIBE_MANIFEST } from './context-manifests.js';
import { reconcileLineageEcho } from './peer-runner-contracts.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import type {
  PeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../runner/peer-runner-types.js';
import type { OutputLanguage } from '../language-directive.js';
import type { LoadedPredecessorArtifact } from './attach-summary-envelope.js';

// ── Scribe-specific context ──────────────────────────────────────────────────

/** Context built by ScribeRunner.buildContext() and consumed by invokeRuntime(). */
interface ScribeContext {
  readonly contextHash: string;
  readonly philosopherArtifact: string;
  readonly sourcePhilosopherArtifactId: string;
}

/**
 * Layer 0 (design §6.1): scribe's edge predecessor is `philosopher`, whose
 * artifact `buildContext` already loaded — this only re-parses the string the
 * runner already holds, so the writer path adds zero store reads (F3).
 */
function toPhilosopherPredecessor(context: ScribeContext): LoadedPredecessorArtifact {
  let contentJson: unknown;
  try {
    contentJson = JSON.parse(context.philosopherArtifact);
  } catch {
    contentJson = context.philosopherArtifact;
  }
  return {
    artifactId: context.sourcePhilosopherArtifactId,
    runnerKind: 'philosopher',
    contentJson,
  };
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
}

// ── ScribeRunner ─────────────────────────────────────────────────────────────

export class ScribeRunner extends BasePeerRunner<ScribeContext, ScribeOutputV1> {
  private readonly validator: ScribeValidator;

  constructor(deps: ScribeRunnerDeps, options: PeerRunnerOptions) {
    super(deps, options, {
      runnerName: 'scribe',
      expectedTaskKind: 'scribe',
      defaultAgentId: 'scribe',
      resultRefPrefix: 'scribe',
    });
    this.validator = deps.validator;
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
        return {
          contextHash: BasePeerRunner.hashContextRefs([artifactRef]),
          philosopherArtifact: firstArtifact.contentJson,
          sourcePhilosopherArtifactId: firstArtifact.artifactId,
        };
      }
    }

    throw new PDRuntimeError('input_invalid', 'Philosopher dependency artifact not found');
  }

  async invokeRuntime(taskId: string, context: ScribeContext): Promise<RunHandle> {
    const {coreGrounding} = this.resolvedOptions;

    let parsedPhilosopherArtifact: unknown;
    try {
      parsedPhilosopherArtifact = JSON.parse(context.philosopherArtifact);
    } catch {
      parsedPhilosopherArtifact = context.philosopherArtifact;
    }

    // Layer 1 (design §6.2/§6.3, task 5.9): resolve the scribe manifest against
    // the loaded philosopher predecessor (carries dreamer 5-dim via its
    // predecessorSummary). Focused → inject only allocated summary fields;
    // fallback → legacy full philosopherArtifact; disabled → unchanged.
    const philosopherPred = toPhilosopherPredecessor(context);
    const resolved = this.resolveContextInjection(taskId, SCRIBE_MANIFEST, philosopherPred.contentJson);
    if (resolved.mode === 'focused') {
      parsedPhilosopherArtifact = resolved.fields;
    }

    const builder = new ScribePromptBuilder({ coreGrounding, outputLanguage: this.resolvedOptions.outputLanguage });
    const { message } = builder.buildPrompt({
      taskId,
      contextHash: context.contextHash,
      philosopherArtifact: parsedPhilosopherArtifact,
      sourcePhilosopherArtifactId: context.sourcePhilosopherArtifactId,
      outputLanguage: this.resolvedOptions.outputLanguage,
      coreGrounding,
    });

    // Rollout needs_revision 修订轮反馈 (P0-E): 任务元数据带 revisionFeedback 时
    // 注入 prompt,让 scribe 针对性修订而非盲目重写。缺失 = 首轮,行为不变。
    const revisionFeedback = await this.resolveRevisionFeedback(taskId);
    const finalMessage = revisionFeedback
      ? `${message}\n\n<revision_feedback>\n${revisionFeedback}\n</revision_feedback>`
      : message;

    return this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: finalMessage,
      contextItems: [],
      outputSchemaRef: 'scribe-output-v1',
      timeoutMs: this.resolvedOptions.timeoutMs,
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
    const result = await this.validator.validate(output, taskId, context.sourcePhilosopherArtifactId);

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
        // Layer 0 (design §6.1, task 3.11): scribe's principle text plus the
        // philosopher-forwarded dreamer dimensions become the summary that
        // artificer/evaluator read at tier0/tier1.
        contentJson: this.buildArtifactContentJson(taskId, 'scribe', output, toPhilosopherPredecessor(context)),
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
    // echo previously dead-ended as output_invalid. Optional trace fields
    // (dreamerArtifactId) have no authoritative value and are left alone.
    const correctedFields = reconcileLineageEcho(untrustedOutput, {
      topFields: [
        { field: 'taskId', authoritativeValue: taskId },
        { field: 'sourcePhilosopherArtifactId', authoritativeValue: _context.sourcePhilosopherArtifactId },
      ],
      trace: {
        traceField: 'sourceTrace',
        fields: [{ field: 'philosopherArtifactId', authoritativeValue: _context.sourcePhilosopherArtifactId }],
      },
    });
    if (correctedFields.length > 0) {
      this.emitEvent('lineage_echo_corrected', taskId, { correctedFields });
    }
  }

  protected override emitSuccessTelemetry(taskId: string, output: ScribeOutputV1): void {
    this.emitEvent('principle_draft_generated', taskId, {
      principleTitle: output.principleDraft.title,
    });
  }
}
