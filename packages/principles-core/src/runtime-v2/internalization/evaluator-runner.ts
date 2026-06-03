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
import type { RunHandle } from '../runtime-protocol.js';
import type { EvaluatorOutputV1, EvaluatorValidator } from './evaluator-output.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory, isPDErrorCategory } from '../error-categories.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { EvaluatorPromptBuilder } from './evaluator-prompt-builder.js';
import { injectRunnerLineageIfAbsent } from './peer-runner-contracts.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import type {
  PeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../runner/peer-runner-types.js';

// ── Evaluator-specific context ────────────────────────────────────────────────

/** Context built by EvaluatorRunner.buildContext() and consumed by invokeRuntime(). */
interface EvaluatorContext {
  readonly contextHash: string;
  readonly artificerArtifact: string | null;
  readonly sourceArtificerArtifactId: string | null;
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

export type EvaluatorRunnerOptions = PeerRunnerOptions;

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

export interface EvaluatorRunnerDeps extends PeerRunnerDeps {
  readonly validator: EvaluatorValidator;
}

// ── EvaluatorRunner ───────────────────────────────────────────────────────────

export class EvaluatorRunner extends BasePeerRunner<EvaluatorContext, EvaluatorOutputV1> {
  private readonly validator: EvaluatorValidator;

  constructor(deps: EvaluatorRunnerDeps, options: PeerRunnerOptions) {
    super(deps, options, {
      runnerName: 'evaluator',
      expectedTaskKind: 'evaluator',
      defaultAgentId: 'evaluator',
      resultRefPrefix: 'evaluator',
    });
    this.validator = deps.validator;
  }

  // ── Abstract implementations ────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid', 'output_invalid']);
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

      const artifacts = await this.artifactStore.listBySourceTaskId(depId);
      if (artifacts.length > 0) {
        const [firstArtifact] = artifacts;
        if (!firstArtifact) continue;
        const artifactRef = firstArtifact.artifactId;
        this.emitEvent('artificer_dep_selected', taskId, {
          depTaskId: depId,
          artifactId: firstArtifact.artifactId,
        });
        return {
          contextHash: BasePeerRunner.hashContextRefs([artifactRef]),
          artificerArtifact: firstArtifact.contentJson,
          sourceArtificerArtifactId: firstArtifact.artifactId,
        };
      }
    }

    this.emitEvent('no_artificer_artifact', taskId, {});
    throw new PDRuntimeError('input_invalid', 'Artificer dependency artifact not found');
  }

  async invokeRuntime(taskId: string, context: EvaluatorContext): Promise<RunHandle> {
    let parsedArtificerArtifact: unknown = null;
    if (context.artificerArtifact) {
      try {
        parsedArtificerArtifact = JSON.parse(context.artificerArtifact);
      } catch {
        parsedArtificerArtifact = context.artificerArtifact;
      }
    }

    const builder = new EvaluatorPromptBuilder();
    const { message } = builder.buildPrompt({
      taskId,
      contextHash: context.contextHash,
      artificerArtifact: parsedArtificerArtifact,
      sourceArtificerArtifactId: context.sourceArtificerArtifactId ?? '',
    });

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
    const result = await this.validator.validate(output as EvaluatorOutputV1, taskId, context.sourceArtificerArtifactId ?? undefined);

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

    // ── Evaluator-specific: validate principle-bearing Scribe artifact ──
    // This is the critical business logic: approved evaluator must validate
    // the Scribe principle artifact, NOT the Artificer plan artifact.
    if (output.evaluation.decision === 'approved') {
      const principleArtifactId = await this.resolvePrincipleBearerArtifact(output, taskId);
      if (principleArtifactId) {
        try {
          const updated = await this.artifactStore.updateValidationStatus(
            principleArtifactId,
            'validated',
          );
          if (!updated) {
            // updateValidationStatus returned false — fail loud with structured telemetry (ERR-018)
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
          });
        }
      }
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
      evaluationDecision: output.evaluation.decision,
      evaluationScore: output.evaluation.score,
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

  // ── Optional hooks ──────────────────────────────────────────────────────────

  /**
   * Re-inject taskId if stripped by stripLineageFields (PRI-272 / ERR-008).
   * Only fill when absent via Object.hasOwn — present-but-falsy values
   * must reach validation and fail loud (Runtime Contract Rule 3).
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown): void {
    injectRunnerLineageIfAbsent(untrustedOutput, 'taskId', taskId);
  }

  protected override emitSuccessTelemetry(taskId: string, output: EvaluatorOutputV1): void {
    this.emitEvent('output_validated', taskId, {
      evaluationDecision: output.evaluation.decision,
      evaluationScore: output.evaluation.score,
    });
  }

  /**
   * Check lineage strip contract after validation passes.
   * Validates sourceTrace.scribeArtifactId consistency (ERR-004, ERR-008).
   */
  protected override checkLineageIntegrity(taskId: string, output: EvaluatorOutputV1): void {
    // sourceTrace.artificerArtifactId must match sourceArtificerArtifactId
    if (output.sourceTrace.artificerArtifactId !== output.sourceArtificerArtifactId) {
      this.emitEvent('lineage_integrity_violation', taskId, {
        sourceArtificerArtifactId: output.sourceArtificerArtifactId,
        traceArtificerArtifactId: output.sourceTrace.artificerArtifactId,
        reason: 'sourceArtificerArtifactId_and_sourceTrace_artificerArtifactId_mismatch',
      });
    }
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
}
