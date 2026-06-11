/**
 * DiagRouterRunner — Stage C runner for the split diagnostician pipeline.
 *
 * Receives both Stage A (Root Cause) and Stage B (Distiller) artifacts and
 * produces the final DiagnosticianOutputV1 — the unchanged downstream contract
 * consumed by the rest of the system.
 *
 * Unlike Stages A and B which only write PIArtifacts, Stage C commits via
 * DiagnosticianCommitter (same as the monolithic DiagnosticianRunner) and
 * calls the onDiagnosisComplete bridge callback (INF-9).
 *
 * Extends BasePeerRunner following the DreamerRunner pattern (PRI-302).
 * The shared lease → buildContext → invoke → poll → fetch → validate →
 * succeed/fail pipeline is in the base class. This file only contains
 * Stage C–specific logic.
 *
 * Key constraints:
 *   - Uses PDRuntimeAdapter for all LLM execution (no direct SDK calls)
 *   - No plugin-layer imports (core is infrastructure-agnostic)
 *   - Uses RuntimeStateManager for all state operations
 *   - Commits via DiagnosticianCommitter (reuses existing committer)
 *   - Calls onDiagnosisComplete callback after commit (INF-9)
 *   - Router MUST NOT re-derive root causes or invent new principles
 *
 * @see PRI-372
 * @see BasePeerRunner in runner/base-peer-runner.ts
 */

import { Value } from '@sinclair/typebox/value';
import type { RunHandle } from '../runtime-protocol.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';
import type { DiagRootCauseOutputV1 } from '../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../diagnostician/diag-distiller-output.js';
import type { DiagnosticianCommitter, CommitResult } from '../store/commit/diagnostician-committer.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { RouterPromptBuilder } from '../diagnostician/router-prompt-builder.js';
import { injectRunnerLineageIfAbsent } from './peer-runner-contracts.js';
import { DefaultDiagnosticianValidator } from '../runner/default-validator.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import type {
  PeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../runner/peer-runner-types.js';

// ── Stage C context ──────────────────────────────────────────────────────────

/** Context built by DiagRouterRunner.buildContext() and consumed by invokeRuntime(). */
interface DiagRouterContext {
  readonly contextHash: string;
  readonly contextRefs: string[];
  readonly rootCauseArtifactId: string;
  readonly rootCauseOutput: DiagRootCauseOutputV1;
  readonly distillerArtifactId: string;
  readonly distillerOutput: DiagDistillerOutputV1;
}

// ── Callback type ────────────────────────────────────────────────────────────

/**
 * Bridge callback invoked after successful diagnosis commit (INF-9).
 *
 * Extracted from the monolithic DiagnosticianRunner to decouple the
 * router stage from host-layer side effects.
 */
export type OnDiagnosisComplete = (taskId: string, output: DiagnosticianOutputV1) => Promise<void>;

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface DiagRouterRunnerDeps extends PeerRunnerDeps {
  readonly committer: DiagnosticianCommitter;
  readonly onDiagnosisComplete: OnDiagnosisComplete;
}

// ── DiagRouterRunner ─────────────────────────────────────────────────────────

/**
 * Stage C runner for the split diagnostician pipeline.
 *
 * Produces the final DiagnosticianOutputV1 by routing the distilled principle
 * from Stage B into the appropriate recommendation taxonomy kind(s). Commits
 * via DiagnosticianCommitter (same as the monolithic DiagnosticianRunner) and
 * calls onDiagnosisComplete after commit.
 *
 * @see PRI-372
 */
export class DiagRouterRunner extends BasePeerRunner<DiagRouterContext, DiagnosticianOutputV1> {
  private readonly committer: DiagnosticianCommitter;
  private readonly onDiagnosisComplete: OnDiagnosisComplete;
  private readonly defaultValidator: DefaultDiagnosticianValidator;

  constructor(deps: DiagRouterRunnerDeps, options: PeerRunnerOptions) {
    super(deps, options, {
      runnerName: 'diag_router',
      expectedTaskKind: 'diag_router',
      defaultAgentId: 'diag_router',
      resultRefPrefix: 'diag-router',
    });
    this.committer = deps.committer;
    this.onDiagnosisComplete = deps.onDiagnosisComplete;
    this.defaultValidator = new DefaultDiagnosticianValidator();
  }

  // ── Abstract implementations ───────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid']);
  }

  async buildContext(taskId: string): Promise<DiagRouterContext> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    if (deps.length < 2) {
      throw new PDRuntimeError('input_invalid', `DiagRouter task ${taskId} requires at least 2 predecessor dependencies (rootcause + distiller), got ${deps.length}`);
    }

    // Resolve predecessor artifacts (both A and B)
    const depResults = await Promise.allSettled(
      deps.map((depId) => this.artifactStore.listBySourceTaskId(depId)),
    );

    // Find Stage A (rootcause) and Stage B (distiller) artifacts
    let rootCauseArtifactId: string | undefined;
    let rootCauseOutput: DiagRootCauseOutputV1 | undefined;
    let distillerArtifactId: string | undefined;
    let distillerOutput: DiagDistillerOutputV1 | undefined;

    for (let i = 0; i < depResults.length; i++) {
      const result = depResults[i];
      if (!result || result.status !== 'fulfilled') continue;
      if (result.value.length === 0) continue;

      const [artifact] = result.value;
      if (!artifact) continue;

      // Determine which stage this artifact belongs to by checking the source task kind
      const depId = deps[i];
      if (depId === undefined) continue;
      const depTask = await this.stateManager.getTask(depId);
      if (!depTask) continue;

      if (depTask.taskKind === 'diag_rootcause' && !rootCauseArtifactId) {
        rootCauseArtifactId = artifact.artifactId;
        try {
          rootCauseOutput = JSON.parse(artifact.contentJson);
        } catch {
          throw new PDRuntimeError('input_invalid', `Failed to parse root cause artifact content for predecessor task ${depId}`);
        }
      } else if (depTask.taskKind === 'diag_distiller' && !distillerArtifactId) {
        distillerArtifactId = artifact.artifactId;
        try {
          distillerOutput = JSON.parse(artifact.contentJson);
        } catch {
          throw new PDRuntimeError('input_invalid', `Failed to parse distiller artifact content for predecessor task ${depId}`);
        }
      }
    }

    if (!rootCauseArtifactId || !rootCauseOutput) {
      throw new PDRuntimeError('input_invalid', `No root cause artifact found for DiagRouter task ${taskId}`);
    }
    if (!distillerArtifactId || !distillerOutput) {
      throw new PDRuntimeError('input_invalid', `No distiller artifact found for DiagRouter task ${taskId}`);
    }

    // Compute contextHash
    const contextRefs: string[] = [rootCauseArtifactId, distillerArtifactId];
    const contextHash = BasePeerRunner.hashContextRefs(contextRefs);

    return {
      contextHash,
      contextRefs,
      rootCauseArtifactId,
      rootCauseOutput,
      distillerArtifactId,
      distillerOutput,
    };
  }

  async invokeRuntime(taskId: string, context: DiagRouterContext): Promise<RunHandle> {
    const builder = new RouterPromptBuilder();
    const { message } = builder.buildPrompt(
      {
        rootCauseArtifactId: context.rootCauseArtifactId,
        rootCauseOutput: context.rootCauseOutput,
        distillerArtifactId: context.distillerArtifactId,
        distillerOutput: context.distillerOutput,
      },
      {
        outputLanguage: this.resolvedOptions.outputLanguage,
      },
    );

    return this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'diagnostician-output-v1',
      timeoutMs: this.resolvedOptions.timeoutMs,
    });
  }

  async validateOutput(output: unknown, taskId: string, _context: DiagRouterContext): Promise<PeerRunnerValidationResult> {
    // Step 1: TypeBox schema check
    if (!Value.Check(DiagnosticianOutputV1Schema, output)) {
      const schemaErrors = [...Value.Errors(DiagnosticianOutputV1Schema, output)]
        .slice(0, 5)
        .map((e) => `${e.path}: ${e.message}`);
      return {
        valid: false,
        errors: schemaErrors,
        errorCategory: 'output_invalid',
      };
    }

    // Step 2: Semantic validation via DefaultDiagnosticianValidator
    const result = await this.defaultValidator.validate(output, taskId);
    return {
      valid: result.valid,
      errors: result.errors,
      errorCategory: result.errorCategory,
    };
  }

  // eslint-disable-next-line @typescript-eslint/max-params
  async succeedTask(
    taskId: string,
    runId: string,
    output: DiagnosticianOutputV1,
    task: TaskRecord,
    contextHash: string,
    _context: DiagRouterContext,
  ): Promise<PeerRunnerResult<DiagnosticianOutputV1>> {
    // 1. Store output before commit
    try {
      await this.stateManager.updateRunOutput(runId, JSON.stringify(output));
    } catch (updateErr) {
      this.emitEvent('update_output_failed', taskId, {
        runId,
        errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
      throw updateErr;
    }

    // 2. Commit via DiagnosticianCommitter (reuse existing committer — same as monolith)
    let commitResult: CommitResult;
    try {
      commitResult = await this.committer.commit({
        runId,
        taskId,
        output,
        idempotencyKey: `${taskId}:${runId}`,
      });
    } catch (commitErr) {
      this.emitEvent('artifact_commit_failed', taskId, {
        taskId,
        runId,
        errorCategory: commitErr instanceof PDRuntimeError ? commitErr.category : 'artifact_commit_failed',
        errorMessage: commitErr instanceof Error ? commitErr.message : String(commitErr),
      });
      throw commitErr;
    }

    // Emit: principle_candidate_registered per recommendation
    for (let i = 0; i < output.recommendations.length; i++) {
      const rec = output.recommendations[i];
      if (!rec) continue;
      this.emitEvent('candidate_registered', taskId, {
        candidateIndex: i,
        commitId: commitResult.commitId,
        kind: rec.kind,
        description: rec.description,
        sourceRunId: runId,
      });
    }

    // Emit: artifact_committed
    this.emitEvent('artifact_committed', taskId, {
      commitId: commitResult.commitId,
      artifactId: commitResult.artifactId,
      candidateCount: commitResult.candidateCount,
      taskId,
      runId,
    });

    // 3. Mark task succeeded
    const resultRef = `commit://${commitResult.commitId}`;
    try {
      await this.stateManager.markTaskSucceeded(taskId, resultRef);
    } catch (stateErr) {
      this.emitEvent('mark_succeeded_failed', taskId, {
        taskId,
        runId,
        commitId: commitResult.commitId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }

    // 4. Call onDiagnosisComplete — the extracted bridge method (INF-9)
    try {
      await this.onDiagnosisComplete(taskId, output);
    } catch (callbackErr) {
      // Bridge callback failure must not prevent the task from being marked succeeded.
      // Emit telemetry for observability but do not throw.
      this.emitEvent('diagnosis_complete_callback_failed', taskId, {
        taskId,
        errorMessage: callbackErr instanceof Error ? callbackErr.message : String(callbackErr),
      });
    }

    // 5. Emit diag_router_task_succeeded telemetry
    const recommendationKinds = output.recommendations.map((r) => r.kind);
    const kindHistogram: Record<string, number> = {};
    for (const kind of recommendationKinds) {
      kindHistogram[kind] = (kindHistogram[kind] ?? 0) + 1;
    }

    this.emitEvent('task_succeeded', taskId, {
      attemptCount: task.attemptCount,
      resultRef,
      commitId: commitResult.commitId,
      candidateCount: commitResult.candidateCount,
      recommendationKindHistogram: kindHistogram,
    });

    return {
      status: 'succeeded',
      taskId,
      runId,
      artifactId: commitResult.artifactId,
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
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown): void {
    injectRunnerLineageIfAbsent(untrustedOutput, 'taskId', taskId);
  }

  protected override emitSuccessTelemetry(taskId: string, output: DiagnosticianOutputV1, _context: DiagRouterContext): void {
    const recommendationKinds = output.recommendations.map((r) => r.kind);
    const kindHistogram: Record<string, number> = {};
    for (const kind of recommendationKinds) {
      kindHistogram[kind] = (kindHistogram[kind] ?? 0) + 1;
    }
    this.emitEvent('router_completed', taskId, {
      recommendationKindHistogram: kindHistogram,
    });
  }
}
