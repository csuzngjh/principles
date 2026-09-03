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
 * Does NOT call onDiagnosisComplete — that is the bridge's responsibility
 * (PainSignalBridge.onPainDetected) to avoid double invocation (P0-1 fix).
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
import { DiagRootCauseOutputV1Schema } from '../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../diagnostician/diag-distiller-output.js';
import { DiagDistillerOutputV1Schema } from '../diagnostician/diag-distiller-output.js';
import type { DiagnosticianCommitter, CommitResult } from '../store/commit/diagnostician-committer.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { RouterPromptBuilder } from '../diagnostician/router-prompt-builder.js';
import { injectRunnerLineageIfAbsent } from './peer-runner-contracts.js';
import { DefaultDiagnosticianValidator } from '../runner/default-validator.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import type { LoadedPredecessorArtifact } from './attach-summary-envelope.js';
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

/**
 * Layer 0 (design §6.1, F17): diag_router's edge predecessor is
 * `diag_distiller` — NOT rootcause, even though buildContext loads both.
 * The rootcause artifact is still consumed by invokeRuntime via its normal
 * path; only the distiller goes into `predecessorSummary`. Reusing the
 * already-validated distiller object keeps the writer path at zero extra
 * store reads (F3). Writer-side only — no manifest, no prompt change, no
 * output-schema change (design §4.7.1).
 */
function toDistillerPredecessor(context: DiagRouterContext): LoadedPredecessorArtifact {
  return {
    artifactId: context.distillerArtifactId,
    runnerKind: 'diag_distiller',
    contentJson: context.distillerOutput,
  };
}

// ── Callback type (removed — P0-1 fix) ─────────────────────────────────────
// OnDiagnosisComplete was previously defined here and wired via the factory's
// bridgeHolder indirection. The bridge (PainSignalBridge.onPainDetected) is
// now the sole invocation point for onDiagnosisComplete, eliminating the
// double-call bug where both Router.succeedTask() and Bridge.onPainDetected()
// each called it once.

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface DiagRouterRunnerDeps extends PeerRunnerDeps {
  readonly committer: DiagnosticianCommitter;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface DiagRouterRunnerOptions extends PeerRunnerOptions {
  /** Effective PD config for feature flag resolution (ADR-0019). */
  readonly effectiveConfig?: EffectivePdConfig;
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
  private readonly defaultValidator: DefaultDiagnosticianValidator;

  constructor(deps: DiagRouterRunnerDeps, options: DiagRouterRunnerOptions) {
    super(deps, options, {
      runnerName: 'diag_router',
      expectedTaskKind: 'diag_router',
      // Use 'main' (the default OpenClaw agent) for CLI invocation.
      // 'diagnostician' is a PD-internal constant (AGENT_IDS.DIAGNOSTICIAN),
      // not an OpenClaw-registered agent. See diag-rootcause-runner.ts for details.
      defaultAgentId: 'main',
      resultRefPrefix: 'diag-router',
      // ADR-0019: pass effectiveConfig so BasePeerRunner.isDegradationEnabled()
      // can read the diagnostician_llm_degradation feature flag.
      effectiveConfig: options.effectiveConfig,
    });
    this.committer = deps.committer;
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
        let parsedRootCause: unknown;
        try {
          parsedRootCause = JSON.parse(artifact.contentJson);
        } catch {
          throw new PDRuntimeError('input_invalid', `Failed to parse root cause artifact content for predecessor task ${depId}`);
        }
        // EP-01: Runtime validation of parsed DB content before typed assignment
        if (!Value.Check(DiagRootCauseOutputV1Schema, parsedRootCause)) {
          const errors = [...Value.Errors(DiagRootCauseOutputV1Schema, parsedRootCause)]
            .slice(0, 3)
            .map((e) => `${e.path}: ${e.message}`);
          throw new PDRuntimeError('input_invalid', `Root cause artifact content failed schema validation for predecessor task ${depId}: ${errors.join('; ')}`);
        }
        rootCauseOutput = parsedRootCause;
      } else if (depTask.taskKind === 'diag_distiller' && !distillerArtifactId) {
        distillerArtifactId = artifact.artifactId;
        let parsedDistiller: unknown;
        try {
          parsedDistiller = JSON.parse(artifact.contentJson);
        } catch {
          throw new PDRuntimeError('input_invalid', `Failed to parse distiller artifact content for predecessor task ${depId}`);
        }
        // EP-01: Runtime validation of parsed DB content before typed assignment
        if (!Value.Check(DiagDistillerOutputV1Schema, parsedDistiller)) {
          const errors = [...Value.Errors(DiagDistillerOutputV1Schema, parsedDistiller)]
            .slice(0, 3)
            .map((e) => `${e.path}: ${e.message}`);
          throw new PDRuntimeError('input_invalid', `Distiller artifact content failed schema validation for predecessor task ${depId}: ${errors.join('; ')}`);
        }
        distillerOutput = parsedDistiller;
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

    const context: DiagRouterContext = {
      contextHash,
      contextRefs,
      rootCauseArtifactId,
      rootCauseOutput,
      distillerArtifactId,
      distillerOutput,
    };

    return context;
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
    context: DiagRouterContext,
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
    // Layer 0 (design §6.1, task 3.11): build the summary envelope here and pass
    // the resulting contentJson to the committer, so the committed principle
    // artifact carries the same `summary` / `predecessorSummary` fields every
    // other SummaryRunnerKind writer attaches. `buildArtifactContentJson`
    // returns `JSON.stringify(output)` verbatim when the flag is off — the
    // committer then writes a byte-identical artifact (Requirement 11.5/11.9).
    const routerContentJson = this.buildArtifactContentJson(taskId, 'diag_router', output, toDistillerPredecessor(context));
    let commitResult: CommitResult;
    try {
      commitResult = await this.committer.commit({
        runId,
        taskId,
        output,
        idempotencyKey: `${taskId}:${runId}`,
        contentJson: routerContentJson,
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

    // 2b. Mirror the committed diagnostician_output into the PI artifact
    // store. Every internalization runner (dreamer and below) reads its
    // predecessor artifact via artifactStore.listBySourceTaskId — the
    // committer only writes the legacy `artifacts` registry, so without this
    // mirror the dreamer resolves its diag_router dependency to an empty list
    // and runs with predecessorOutput === null, and every downstream stage
    // derives candidates from the missing context instead of the pain
    // (PRI-634-C closure validation finding, 2026-09-03). Same artifactId as
    // the legacy row keeps one identity across both stores; contentJson is
    // the same Layer 0 envelope string handed to the committer, so both
    // stores stay byte-identical (Requirement 11.5/11.9).
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
        resolvedCount: lineageArtifactIds.length,
        warning: 'Some dependency artifact queries were rejected; lineage may be incomplete',
      });
    }
    const piNow = new Date().toISOString();
    try {
      await this.artifactStore.upsertArtifact({
        artifactId: commitResult.artifactId,
        artifactKind: 'principle',
        sourceTaskId: taskId,
        lineageArtifactIds,
        validationStatus: 'pending',
        contentJson: routerContentJson,
        createdAt: piNow,
        updatedAt: piNow,
      });
    } catch (piArtifactErr) {
      this.emitEvent('artifact_write_failed', taskId, {
        runId,
        errorMessage: piArtifactErr instanceof Error ? piArtifactErr.message : String(piArtifactErr),
      });
      return this.retryOrFail({
        taskId,
        task,
        errorCategory: 'artifact_commit_failed',
        failureReason: `PIArtifact mirror of diagnostician_output failed: ${piArtifactErr instanceof Error ? piArtifactErr.message : String(piArtifactErr)}`,
      });
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

    // 4. Emit diag_router_task_succeeded telemetry
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
   * P0: Inject invariant fields from upstream artifacts into LLM output.
   * P2: Override rootCause/evidence/confidence if LLM generated inconsistent values.
   *
   * These fields are deterministic copies from Stage A and Stage B — the LLM
   * MUST NOT control them. By injecting here (before validation), we:
   *   1. Eliminate the risk of LLM rephrasing rootCause or inventing evidence
   *   2. Reduce LLM output complexity (fewer fields = fewer errors on weak models)
   *   3. Ensure EP-07 compliance (rootCause from Stage A, confidence from Stage B)
   *
   * Also re-injects taskId if stripped by stripLineageFields (PRI-272 / ERR-008).
   */
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown, context: DiagRouterContext): void {
    // Legacy: re-inject taskId if stripped by adapter
    injectRunnerLineageIfAbsent(untrustedOutput, 'taskId', taskId);

    // P0: Inject invariant fields from upstream artifacts
    if (typeof untrustedOutput === 'object' && untrustedOutput !== null && !Array.isArray(untrustedOutput)) {
      const output = untrustedOutput as Record<string, unknown>;

      // rootCause ← Stage A (EP-07: must come from rootCauseOutput, not LLM)
      const stageARootCause = context.rootCauseOutput.rootCause;
      if (stageARootCause !== undefined) {
        if (output.rootCause !== stageARootCause && output.rootCause !== undefined) {
          // P2: LLM generated a different rootCause — override and emit telemetry
          this.emitEvent('invariant_override', taskId, {
            field: 'rootCause',
            reason: 'LLM output did not match Stage A rootCause — overridden with upstream value',
          });
        }
        output.rootCause = stageARootCause;
      }

      // evidence ← Stage A
      const stageAEvidence = context.rootCauseOutput.evidence;
      if (stageAEvidence !== undefined) {
        if (output.evidence !== stageAEvidence && output.evidence !== undefined) {
          this.emitEvent('invariant_override', taskId, {
            field: 'evidence',
            reason: 'LLM output did not match Stage A evidence — overridden with upstream value',
          });
        }
        output.evidence = stageAEvidence;
      }

      // confidence ← Stage B (EP-07: must come from distillerOutput, not LLM)
      const stageBConfidence = context.distillerOutput.confidence;
      if (stageBConfidence !== undefined) {
        if (output.confidence !== stageBConfidence && output.confidence !== undefined) {
          this.emitEvent('invariant_override', taskId, {
            field: 'confidence',
            reason: 'LLM output did not match Stage B confidence — overridden with upstream value',
          });
        }
        output.confidence = stageBConfidence;
      }

      // PRI-468: intentTension ← Stage A (additive passthrough, SPEC §18)
      //
      // Stage C MUST NOT generate intentTension when Stage A omitted it
      // (SPEC §18.2). Only copy it through when Stage A actually produced
      // a defined value. If Stage A did not produce one (absent or
      // undefined), strip any LLM-hallucinated intentTension.
      const stageAIntentTension = context.rootCauseOutput.intentTension;
      if (stageAIntentTension !== undefined) {
        // Passthrough: copy Stage A intentTension to Stage C output.
        // If LLM also produced one, override with Stage A (source of truth).
        if (output.intentTension !== undefined) {
          this.emitEvent('invariant_override', taskId, {
            field: 'intentTension',
            reason: 'LLM output had intentTension — overridden with Stage A passthrough value (SPEC §18.1)',
          });
        }
        output.intentTension = stageAIntentTension;
      }
      // When Stage A did NOT produce intentTension, we do NOT add one.
      // If LLM hallucinated one, strip it to enforce SPEC §18.2.
      else if (output.intentTension !== undefined) {
        this.emitEvent('invariant_override', taskId, {
          field: 'intentTension',
          reason: 'LLM output had intentTension but Stage A did not produce one — stripped (SPEC §18.2: additive only, never generates)',
        });
        delete output.intentTension;
      }
    }
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
