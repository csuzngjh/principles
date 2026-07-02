/**
 * DiagDistillerRunner — Stage B runner for the split diagnostician pipeline.
 *
 * Takes the root-cause artifact from Stage A and produces an abstracted,
 * cross-scenario principle grounded on the T-01..T-10 core axiom registry.
 *
 * Extends BasePeerRunner following the DreamerRunner pattern (PRI-302).
 * The shared lease → buildContext → invoke → poll → fetch → validate →
 * succeed/fail pipeline is in the base class. This file only contains
 * Stage B–specific logic.
 *
 * Key constraints:
 *   - Uses PDRuntimeAdapter for all LLM execution (no direct SDK calls)
 *   - No plugin-layer imports (core is infrastructure-agnostic)
 *   - Uses RuntimeStateManager for all state operations
 *   - NO candidate commit — only writes PIArtifact (like DreamerRunner)
 *   - Reads diagnostician_core_grounding flag from effectiveConfig (PRI-371)
 *   - Validates groundedOnCorePrincipleIds against registry (fabricated IDs fail)
 *   - Lineage integrity: output.sourceRootCauseArtifactId must match context
 *
 * @see PRI-372
 * @see BasePeerRunner in runner/base-peer-runner.ts
 */

import { Value } from '@sinclair/typebox/value';
import type { RunHandle } from '../runtime-protocol.js';
import type { DiagDistillerOutputV1, DiagDistillerValidator } from '../diagnostician/diag-distiller-output.js';
import type { DiagRootCauseOutputV1 } from '../diagnostician/diag-rootcause-output.js';
import { DiagRootCauseOutputV1Schema } from '../diagnostician/diag-rootcause-output.js';
import type { TaskRecord } from '../task-status.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { DistillerPromptBuilder } from '../diagnostician/distiller-prompt-builder.js';
import { injectRunnerLineageIfAbsent } from './peer-runner-contracts.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '../config/pd-config-feature-flags.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import type {
  PeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../runner/peer-runner-types.js';

// ── Stage B context ──────────────────────────────────────────────────────────

/** Context built by DiagDistillerRunner.buildContext() and consumed by invokeRuntime(). */
interface DiagDistillerContext {
  readonly contextHash: string;
  readonly contextRefs: string[];
  readonly rootCauseArtifactId: string;
  readonly rootCauseOutput: DiagRootCauseOutputV1;
  readonly coreGrounding: boolean;
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface DiagDistillerRunnerDeps extends PeerRunnerDeps {
  readonly validator: DiagDistillerValidator;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface DiagDistillerRunnerOptions extends PeerRunnerOptions {
  /** Effective PD config for feature flag resolution (PRI-371). */
  readonly effectiveConfig?: EffectivePdConfig;
}

// ── DiagDistillerRunner ──────────────────────────────────────────────────────

/**
 * Stage B runner for the split diagnostician pipeline.
 *
 * Produces a DiagDistillerOutputV1 containing the abstracted principle,
 * core axiom grounding, scope, and confidence. Does NOT commit candidates —
 * that is the responsibility of Stage C (DiagRouterRunner).
 *
 * @see PRI-372
 */
export class DiagDistillerRunner extends BasePeerRunner<DiagDistillerContext, DiagDistillerOutputV1> {
  private readonly validator: DiagDistillerValidator;
  private readonly effectiveConfig?: EffectivePdConfig;

  constructor(deps: DiagDistillerRunnerDeps, options: DiagDistillerRunnerOptions) {
    super(deps, options, {
      runnerName: 'diag_distiller',
      expectedTaskKind: 'diag_distiller',
      // Use 'main' (the default OpenClaw agent) for CLI invocation.
      // 'diagnostician' is a PD-internal constant (AGENT_IDS.DIAGNOSTICIAN),
      // not an OpenClaw-registered agent. See diag-rootcause-runner.ts for details.
      defaultAgentId: 'main',
      resultRefPrefix: 'diag-distiller',
    });
    this.validator = deps.validator;
    this.effectiveConfig = options.effectiveConfig;
  }

  // ── Abstract implementations ───────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid']);
  }

  async buildContext(taskId: string): Promise<DiagDistillerContext> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    if (deps.length === 0) {
      throw new PDRuntimeError('input_invalid', `DiagDistiller task ${taskId} has no predecessor dependency`);
    }

    // Resolve predecessor artifact (Stage A root cause)
    const [depId] = deps;
    if (!depId) {
      throw new PDRuntimeError('input_invalid', `DiagDistiller task ${taskId} has no predecessor dependency`);
    }
    const artifacts = await this.artifactStore.listBySourceTaskId(depId);
    if (artifacts.length === 0) {
      throw new PDRuntimeError('input_invalid', `No root cause artifact found for predecessor task ${depId}`);
    }

    const [rootCauseArtifact] = artifacts;
    if (!rootCauseArtifact) {
      throw new PDRuntimeError('input_invalid', `No root cause artifact found for predecessor task ${depId}`);
    }
    const rootCauseArtifactId = rootCauseArtifact.artifactId;

    // Parse predecessor output — ERR-001: treat parsed artifact content as unknown
    // before runtime validation (Runtime Contract Rule 1).
    let rootCauseOutput: DiagRootCauseOutputV1;
    let parsedRootCause: unknown;
    try {
      parsedRootCause = JSON.parse(rootCauseArtifact.contentJson);
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

    // Read coreGrounding flag from effectiveConfig
    let coreGrounding = false;
    if (this.effectiveConfig) {
      const featureFlags = computeFeatureFlagsFromConfig(this.effectiveConfig);
      coreGrounding = isFeatureEnabled(featureFlags, 'diagnostician_core_grounding');
    }

    // Compute contextHash
    const contextRefs: string[] = [rootCauseArtifactId];
    if (rootCauseArtifact.lineageArtifactIds) {
      contextRefs.push(...rootCauseArtifact.lineageArtifactIds);
    }
    const contextHash = BasePeerRunner.hashContextRefs(contextRefs);

    const context: DiagDistillerContext = { contextHash, contextRefs, rootCauseArtifactId, rootCauseOutput, coreGrounding };
    return context;
  }

  async invokeRuntime(taskId: string, context: DiagDistillerContext): Promise<RunHandle> {
    const builder = new DistillerPromptBuilder();
    const { message } = builder.buildPrompt(
      {
        rootCauseArtifactId: context.rootCauseArtifactId,
        rootCauseOutput: context.rootCauseOutput,
        coreGrounding: context.coreGrounding,
      },
      {
        outputLanguage: this.resolvedOptions.outputLanguage,
        coreGrounding: context.coreGrounding,
      },
    );

    return this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'diag-distiller-output-v1',
      timeoutMs: this.resolvedOptions.timeoutMs,
    });
  }

  async validateOutput(output: unknown, taskId: string, _context: DiagDistillerContext): Promise<PeerRunnerValidationResult> {
    const result = await this.validator.validate(output, taskId);
    return {
      valid: result.valid,
      errors: result.errors,
      errorCategory: result.errorCategory as PDErrorCategory | undefined,
    };
  }

  // eslint-disable-next-line @typescript-eslint/max-params
  async succeedTask(
    taskId: string,
    runId: string,
    output: DiagDistillerOutputV1,
    task: TaskRecord,
    contextHash: string,
    _context: DiagDistillerContext,
  ): Promise<PeerRunnerResult<DiagDistillerOutputV1>> {
    // 1. Store output before marking succeeded
    try {
      await this.stateManager.updateRunOutput(runId, JSON.stringify(output));
    } catch (updateErr) {
      this.emitEvent('update_output_failed', taskId, {
        runId,
        errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
      throw updateErr;
    }

    // 2. Write PIArtifact via artifactStore (idempotent upsert) — NO candidate commit
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

    // 3. Mark task succeeded
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

    // 4. Emit diag_distiller_task_succeeded telemetry
    this.emitEvent('task_succeeded', taskId, {
      attemptCount: task.attemptCount,
      resultRef,
      groundedOnCorePrincipleIds: output.groundedOnCorePrincipleIds,
      scope: output.scope,
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
   * Re-inject taskId and sourceRootCauseArtifactId if stripped by
   * stripLineageFields (PRI-272 / ERR-008).
   * Only fill when absent via Object.hasOwn — present-but-falsy values
   * must reach validation and fail loud (Runtime Contract Rule 3).
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown): void {
    injectRunnerLineageIfAbsent(untrustedOutput, 'taskId', taskId);
    // sourceRootCauseArtifactId is NOT re-injected here because it comes
    // from the predecessor artifact, not from the runner's own context.
    // The validator checks its value against the expected artifact ID.
  }

  /**
   * Check lineage strip contract invariant (EP-07).
   *
   * After validation passes, verify that the output's sourceRootCauseArtifactId
   * matches the context's rootCauseArtifactId. If they mismatch, the LLM
   * fabricated or altered the lineage field — emit telemetry and throw.
   */
  protected override checkLineageIntegrity(taskId: string, output: DiagDistillerOutputV1, context: DiagDistillerContext): void {
    if (context.rootCauseArtifactId && output.sourceRootCauseArtifactId !== context.rootCauseArtifactId) {
      this.emitEvent('lineage_integrity_violation', taskId, {
        expectedArtifactId: context.rootCauseArtifactId,
        actualArtifactId: output.sourceRootCauseArtifactId,
        field: 'sourceRootCauseArtifactId',
      });
      throw new PDRuntimeError('output_invalid', `sourceRootCauseArtifactId mismatch: expected ${context.rootCauseArtifactId}, got ${output.sourceRootCauseArtifactId}`);
    }
  }

  protected override emitSuccessTelemetry(taskId: string, output: DiagDistillerOutputV1, _context: DiagDistillerContext): void {
    this.emitEvent('distiller_completed', taskId, {
      groundedOnCorePrincipleIds: output.groundedOnCorePrincipleIds,
      scope: output.scope,
      confidence: output.confidence,
    });
  }
}
