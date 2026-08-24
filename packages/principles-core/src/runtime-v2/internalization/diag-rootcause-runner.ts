/**
 * DiagRootCauseRunner — Stage A runner for the split diagnostician pipeline.
 *
 * Identifies the underlying cause of a pain signal using a 5-Whys causal
 * chain and categorises it into one of four root-cause categories.
 *
 * Extends BasePeerRunner following the DreamerRunner pattern (PRI-302).
 * The shared lease → buildContext → invoke → poll → fetch → validate →
 * succeed/fail pipeline is in the base class. This file only contains
 * Stage A–specific logic.
 *
 * Key constraints:
 *   - Uses PDRuntimeAdapter for all LLM execution (no direct SDK calls)
 *   - No plugin-layer imports (core is infrastructure-agnostic)
 *   - Uses RuntimeStateManager for all state operations
 *   - NO candidate commit — only writes PIArtifact (like DreamerRunner)
 *   - Reads diagnostician_core_grounding flag from effectiveConfig (PRI-371)
 *
 * @see PRI-372
 * @see BasePeerRunner in runner/base-peer-runner.ts
 */

import type { RunHandle } from '../runtime-protocol.js';
import type { DiagRootCauseOutputV1, DiagRootCauseValidator } from '../diagnostician/diag-rootcause-output.js';
import type { DiagnosticianContextPayload } from '../context-payload.js';
import type { ContextAssembler } from '../store/context/context-assembler.js';
import type { TaskRecord } from '../task-status.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import type { IntentDocReader } from '../intent/intent-doc-reader-port.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { RootCausePromptBuilder } from '../diagnostician/rootcause-prompt-builder.js';
import { injectRunnerLineageIfAbsent } from './peer-runner-contracts.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '../config/pd-config-feature-flags.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import type {
  PeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../runner/peer-runner-types.js';

// ── Stage A context ──────────────────────────────────────────────────────────

/** Context built by DiagRootCauseRunner.buildContext() and consumed by invokeRuntime(). */
interface DiagRootCauseContext {
  readonly contextHash: string;
  readonly contextRefs: string[];
  readonly painPayload: DiagnosticianContextPayload;
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface DiagRootCauseRunnerDeps extends PeerRunnerDeps {
  readonly validator: DiagRootCauseValidator;
  readonly contextAssembler: ContextAssembler;
  /**
   * PRI-468: Optional INTENT.md reader for Stage A intent tension check.
   *
   * When provided AND `intent_engineering` flag is on, the runner reads
   * INTENT.md and injects it into the Stage A prompt as reference context
   * for the LLM to optionally produce `intentTension`.
   *
   * When absent or flag off, the runner behaves as before (byte-identical
   * prompt — EP-03: no silent fallback).
   */
  readonly intentDocReader?: IntentDocReader;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface DiagRootCauseRunnerOptions extends PeerRunnerOptions {
  /** Effective PD config for feature flag resolution (PRI-371). */
  readonly effectiveConfig?: EffectivePdConfig;
}

// ── DiagRootCauseRunner ──────────────────────────────────────────────────────

/**
 * Stage A runner for the split diagnostician pipeline.
 *
 * Produces a DiagRootCauseOutputV1 containing the 5-Whys causal chain,
 * root cause classification, and evidence. Does NOT commit candidates —
 * that is the responsibility of Stage C (DiagRouterRunner).
 *
 * @see PRI-372
 */
export class DiagRootCauseRunner extends BasePeerRunner<DiagRootCauseContext, DiagRootCauseOutputV1> {
  private readonly validator: DiagRootCauseValidator;
  private readonly contextAssembler: ContextAssembler;
  private readonly effectiveConfig?: EffectivePdConfig;
  private readonly intentDocReader?: IntentDocReader;

  constructor(deps: DiagRootCauseRunnerDeps, options: DiagRootCauseRunnerOptions) {
    super(deps, options, {
      runnerName: 'diag_rootcause',
      expectedTaskKind: 'diag_rootcause',
      // Use 'main' (the default OpenClaw agent) for CLI invocation.
      // 'diagnostician' is a PD-internal constant (AGENT_IDS.DIAGNOSTICIAN),
      // not an OpenClaw-registered agent. The OpenClaw CLI rejects unknown
      // agent IDs with "Unknown agent id".
      // runnerName/expectedTaskKind still distinguish the stage internally;
      // outputSchemaRef still selects the correct output schema.
      defaultAgentId: 'main',
      resultRefPrefix: 'diag-rootcause',
      // ADR-0019: pass effectiveConfig so BasePeerRunner.isDegradationEnabled()
      // can read the diagnostician_llm_degradation feature flag.
      effectiveConfig: options.effectiveConfig,
    });
    this.validator = deps.validator;
    this.contextAssembler = deps.contextAssembler;
    this.effectiveConfig = options.effectiveConfig;
    this.intentDocReader = deps.intentDocReader;
  }

  // ── Abstract implementations ───────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid']);
  }

  async buildContext(taskId: string): Promise<DiagRootCauseContext> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const parentTaskId = task.inputRef || taskId;

    // Assemble pain signal context via ContextAssembler
    const painPayload = await this.contextAssembler.assemble(parentTaskId);

    // Compute contextHash from sourceRefs
    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];
    const contextRefs: string[] = [...painPayload.sourceRefs];

    // Include predecessor result refs
    if (deps.length > 0) {
      const results = await Promise.allSettled(
        deps.map((depId) => this.stateManager.getTask(depId)),
      );
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const depId = deps[i];
        if (!result || depId === undefined) continue;
        if (result.status === 'fulfilled' && result.value) {
          if (result.value.resultRef) {
            contextRefs.push(result.value.resultRef);
          }
          const depPiTask = result.value ? hydratePITaskRecord(result.value) : null;
          if (depPiTask?.outputArtifactRefs) {
            contextRefs.push(...depPiTask.outputArtifactRefs.map((a) => a.ref));
          }
        }
      }
    }

    const contextHash = BasePeerRunner.hashContextRefs(contextRefs);
    return { contextHash, contextRefs, painPayload };
  }

  async invokeRuntime(taskId: string, context: DiagRootCauseContext): Promise<RunHandle> {
    // T-E (PRI-371): Read diagnostician_core_grounding flag from effective config.
    let coreGrounding = false;
    // PRI-468: Read intent_engineering flag from effective config.
    let intentGrounding = false;
    // Pain Diagnosis Persistence: Evidence First Attribution rules in the
    // Stage A prompt. Flag off (default) keeps the prompt byte-identical.
    let evidenceFirstAttribution = false;
    if (this.effectiveConfig) {
      const featureFlags = computeFeatureFlagsFromConfig(this.effectiveConfig);
      coreGrounding = isFeatureEnabled(featureFlags, 'diagnostician_core_grounding');
      intentGrounding = isFeatureEnabled(featureFlags, 'intent_engineering');
      evidenceFirstAttribution = isFeatureEnabled(featureFlags, 'pain_diagnosis_persistence');
    }

    // PRI-468: When intent_engineering is on AND a reader is configured,
    // attempt to read INTENT.md. On any degraded path (not_found, oversized,
    // read_error, flag_disabled, or no reader configured), intentGrounding
    // is downgraded to false and the prompt is byte-identical to the
    // pre-PRI-468 prompt (EP-03 / ERR-002: graceful degradation with
    // observable telemetry).
    let intentDoc: { raw: string; contentHash: string; path: string } | undefined;
    if (intentGrounding && !this.intentDocReader) {
      // Flag on but no reader wired — downgrade silently (factory misconfiguration
      // is not a per-task event; it's a startup-time issue). The prompt stays
      // byte-identical to pre-PRI-468.
      intentGrounding = false;
    } else if (intentGrounding && this.intentDocReader) {
      const readResult = this.intentDocReader.readIntentDoc();
      if (readResult.ok && readResult.doc) {
        intentDoc = {
          raw: readResult.doc.raw,
          contentHash: readResult.doc.contentHash,
          path: readResult.doc.path,
        };
      } else {
        // EP-03 / ERR-002: degrade gracefully but observably.
        // Flag stays on in config, but we do not inject INTENT — emit
        // telemetry so the operator can see why INTENT was not injected.
        this.emitEvent('intent_doc_read_failed', taskId, {
          reason: readResult.reason ?? 'unknown',
          nextAction: readResult.nextAction ?? 'Check INTENT.md configuration.',
          flagEnabled: readResult.flagEnabled,
          found: readResult.found,
        });
        intentGrounding = false;
      }
    }

    const builder = new RootCausePromptBuilder();
    const { message } = builder.buildPrompt(context.painPayload, {
      outputLanguage: this.resolvedOptions.outputLanguage,
      coreGrounding,
      intentGrounding,
      intentDoc,
      evidenceFirstAttribution,
    });

    return this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'diag-rootcause-output-v1',
      timeoutMs: this.resolvedOptions.timeoutMs,
    });
  }

  async validateOutput(output: unknown, taskId: string, _context: DiagRootCauseContext): Promise<PeerRunnerValidationResult> {
    const result = await this.validator.validate(output, taskId);
    return {
      valid: result.valid,
      errors: result.errors,
      errorCategory: result.errorCategory as PDErrorCategory | undefined,
      warnings: result.warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/max-params
  async succeedTask(
    taskId: string,
    runId: string,
    output: DiagRootCauseOutputV1,
    task: TaskRecord,
    contextHash: string,
    _context: DiagRootCauseContext,
  ): Promise<PeerRunnerResult<DiagRootCauseOutputV1>> {
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
        // Layer 0 (design §6.1, task 3.11): diag_rootcause is the chain root —
        // its edge predecessor is null, so only the self `summary` is written
        // (no `predecessorSummary`). Writer-side only: no manifest, no prompt
        // change, no output-schema change (design §4.7.1).
        contentJson: this.buildArtifactContentJson(taskId, 'diag_rootcause', output, null),
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

    // 4. Emit diag_rootcause_task_succeeded telemetry
    this.emitEvent('task_succeeded', taskId, {
      attemptCount: task.attemptCount,
      resultRef,
      rootCauseCategory: output.rootCauseCategory,
      causalChainDepth: output.causalChain.length,
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
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown): void {
    injectRunnerLineageIfAbsent(untrustedOutput, 'taskId', taskId);
  }

  protected override emitSuccessTelemetry(taskId: string, output: DiagRootCauseOutputV1, _context: DiagRootCauseContext): void {
    this.emitEvent('rootcause_completed', taskId, {
      rootCauseCategory: output.rootCauseCategory,
      causalChainDepth: output.causalChain.length,
    });
  }
}
