/**
 * ArtificerRunner — Implementation plan generator for the Internalization Engine (PRI-111).
 *
 * Migrated to extend BasePeerRunner (PRI-302). The shared lease → buildContext →
 * invoke → poll → fetch → validate → succeed/fail pipeline is now in the base
 * class. This file only contains Artificer-specific logic.
 *
 * Key constraints (ADR-0003):
 *   - Uses PDRuntimeAdapter for all LLM execution (no direct SDK calls)
 *   - Does NOT directly invoke Evaluator/RolloutReviewer (host layer enqueues)
 *   - No plugin-layer imports (core is infrastructure-agnostic)
 *   - Uses RuntimeStateManager for all state operations
 *
 * Trust boundary (Artificer is activation-capable, higher risk than upstream runners):
 *   - LLM output enters as `unknown`; only after validateOutput + lineage check
 *     can it be treated as ArtificerRuleOutput
 *   - sourceScribeArtifactId lineage consistency enforced in succeedTask (ERR-004)
 *   - Invalid activation/action/channel cannot succeed commit
 *   - Artifact write failure → retryOrFail, never silent
 *
 * Pipeline:
 *   1. acquireLease — isolated try/catch, lease_conflict is non-mutating
 *   2. resolve Scribe dependency from dependencyTaskIds
 *   3. fetch Scribe artifact via PIArtifactStore
 *   4. startRun with outputSchemaRef: 'artificer-rule-output-v2'
 *   5. pollUntilTerminal (inherited)
 *   6. fetchOutput → validate as unknown → cast to ArtificerRuleOutput
 *   7. checkLineageIntegrity (sourceScribeArtifactId consistency, ERR-008)
 *   8. updateRunOutput → persist serialized output
 *   9. write PIArtifact → markTaskSucceeded with artificer:// resultRef
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 * @see BasePeerRunner in runner/base-peer-runner.ts
 */
import type { RunHandle } from '../runtime-protocol.js';
import type { ArtificerRuleOutput, ArtificerValidator } from './artificer-output.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory, isPDErrorCategory } from '../error-categories.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { ArtificerPromptBuilder } from './artificer-prompt-builder.js';
import { injectRunnerLineageIfAbsent } from './peer-runner-contracts.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import type {
  PeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../runner/peer-runner-types.js';

// ── Artificer-specific context ──────────────────────────────────────────────

/** Context built by ArtificerRunner.buildContext() and consumed by invokeRuntime(). */
interface ArtificerContext {
  readonly contextHash: string;
  readonly scribeArtifact: string | null;
  readonly sourceScribeArtifactId: string | null;
  /**
   * Prior adversarial replay failures (PRI-428). Non-null only on Round-2+
   * retries inside runAdversarialLoop, read from the task's
   * PITaskMetadata.adversarialFeedback. Forwarded to the prompt builder so the
   * LLM can make targeted corrections.
   */
  readonly adversarialFeedback: string | null;
}

// ── Result Types (backward-compatible exports) ───────────────────────────────

export type ArtificerRunnerResultStatus = 'succeeded' | 'failed' | 'retried';

export interface ArtificerRunnerResult {
  readonly status: ArtificerRunnerResultStatus;
  readonly taskId: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly resultRef?: string;
  readonly contextHash?: string;
  readonly output?: ArtificerRuleOutput;
  readonly errorCategory?: PDErrorCategory;
  readonly failureReason?: string;
  readonly attemptCount: number;
}

// ── Constructor Options (backward-compatible exports) ────────────────────────

export interface ArtificerRunnerOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly defaultMaxAttempts?: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId?: string;
}

export interface ResolvedArtificerRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
}

const DEFAULT_ARTIFICER_RUNNER_OPTIONS: Readonly<Omit<ResolvedArtificerRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'artificer',
} as const;

export function resolveArtificerRunnerOptions(options: ArtificerRunnerOptions): ResolvedArtificerRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_ARTIFICER_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_ARTIFICER_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_ARTIFICER_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? DEFAULT_ARTIFICER_RUNNER_OPTIONS.agentId,
  };
}

// ── Dependencies (backward-compatible; extends PeerRunnerDeps) ───────────────

export interface ArtificerRunnerDeps extends PeerRunnerDeps {
  readonly validator: ArtificerValidator;
}

// ── ArtificerRunner ──────────────────────────────────────────────────────────

export class ArtificerRunner extends BasePeerRunner<ArtificerContext, ArtificerRuleOutput> {
  private readonly validator: ArtificerValidator;

  constructor(deps: ArtificerRunnerDeps, options: PeerRunnerOptions) {
    super(deps, options, {
      runnerName: 'artificer',
      expectedTaskKind: 'artificer',
      defaultAgentId: 'artificer',
      resultRefPrefix: 'artificer',
    });
    this.validator = deps.validator;
  }

  // ── Abstract implementations ───────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid', 'output_invalid']);
  }

  async buildContext(taskId: string): Promise<ArtificerContext> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    // PRI-428: carry prior adversarial replay failures into the prompt when
    // this is a Round-2+ retry. Validated as non-empty string by the metadata
    // parser; null when absent (Round 1 / non-loop invocations).
    const adversarialFeedback = typeof piTask?.adversarialFeedback === 'string'
      && piTask.adversarialFeedback.trim() !== ''
      ? piTask.adversarialFeedback
      : null;

    if (deps.length === 0) {
      this.emitEvent('no_dependencies', taskId, {});
      return { contextHash: 'empty', scribeArtifact: null, sourceScribeArtifactId: null, adversarialFeedback };
    }

    for (const depId of deps) {
      const depTask = await this.stateManager.getTask(depId);
      if (!depTask) continue;
      if (depTask.taskKind !== 'scribe') continue;
      if (depTask.status !== 'succeeded') {
        this.emitEvent('dependency_not_succeeded', taskId, {
          depTaskId: depId,
          depStatus: depTask.status,
        });
        continue;
      }

      const artifacts = await this.artifactStore.listBySourceTaskId(depId);
      if (artifacts.length > 0) {
        const [firstArtifact] = artifacts;
        if (!firstArtifact) continue;
        const artifactRef = firstArtifact.artifactId;
        this.emitEvent('scribe_dep_selected', taskId, {
          depTaskId: depId,
          artifactId: firstArtifact.artifactId,
        });
        return {
          contextHash: BasePeerRunner.hashContextRefs([artifactRef]),
          scribeArtifact: firstArtifact.contentJson,
          sourceScribeArtifactId: firstArtifact.artifactId,
          adversarialFeedback,
        };
      }
    }

    this.emitEvent('no_scribe_artifact', taskId, {});
    return { contextHash: 'empty', scribeArtifact: null, sourceScribeArtifactId: null, adversarialFeedback };
  }

  async invokeRuntime(taskId: string, context: ArtificerContext): Promise<RunHandle> {
    if (!context.scribeArtifact || !context.sourceScribeArtifactId) {
      throw new PDRuntimeError('input_invalid', 'Scribe dependency artifact not resolved');
    }

    let scribeArtifactInput: unknown;
    try {
      scribeArtifactInput = JSON.parse(context.scribeArtifact);
    } catch {
      scribeArtifactInput = context.scribeArtifact;
    }

    const builder = new ArtificerPromptBuilder();
    const { message } = builder.buildPrompt({
      taskId,
      contextHash: context.contextHash,
      scribeArtifact: scribeArtifactInput,
      sourceScribeArtifactId: context.sourceScribeArtifactId,
      adversarialFeedback: context.adversarialFeedback ?? undefined,
    });

    return this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'artificer-rule-output-v2',
      timeoutMs: this.resolvedOptions.timeoutMs,
    });
  }

  async validateOutput(output: unknown, taskId: string, context: ArtificerContext): Promise<PeerRunnerValidationResult> {
    const result = await this.validator.validate(output, taskId, context.sourceScribeArtifactId ?? undefined);

    // Trust-boundary: validator returns `string | undefined` for errorCategory.
    // Must not `as`-cast; validate at runtime (ERR-001, ERR-005).
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
    output: ArtificerRuleOutput,
    task: TaskRecord,
    contextHash: string,
    context: ArtificerContext,
  ): Promise<PeerRunnerResult<ArtificerRuleOutput>> {
    // Lineage consistency: sourceScribeArtifactId must match buildContext result (ERR-004, ERR-008).
    if (!context.sourceScribeArtifactId || output.sourceScribeArtifactId !== context.sourceScribeArtifactId) {
      throw new PDRuntimeError(
        'output_invalid',
        `sourceScribeArtifactId mismatch: expected ${context.sourceScribeArtifactId ?? '(none)'}, got ${output.sourceScribeArtifactId}`,
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
        contentJson: JSON.stringify(output),
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
      implementationSummary: output.implementationSummary,
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
   * generatedAt override is handled by the base class — subclasses must call
   * super.postFetchTransform() to inherit it.
   */
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown, _context: ArtificerContext): void {
    super.postFetchTransform(taskId, untrustedOutput, _context);
    injectRunnerLineageIfAbsent(untrustedOutput, 'taskId', taskId);
  }

  protected override emitSuccessTelemetry(taskId: string, output: ArtificerRuleOutput): void {
    this.emitEvent('implementation_plan_generated', taskId, {
      implementationSummary: output.implementationSummary,
      affectedTools: output.affectedTools,
      goldenTraceCaseCount: output.goldenTraceCases.length,
    });
  }
}

export { DEFAULT_ARTIFICER_RUNNER_OPTIONS };
