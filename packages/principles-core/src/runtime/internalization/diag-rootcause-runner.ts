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
import { RUNTIME_CONTRACT_SCHEMA_VERSION } from '../schema-version.js';
import type { DiagRootCauseOutputV1, DiagRootCauseValidator } from '../diagnostician/diag-rootcause-output.js';
import type { DiagnosticianContextPayload } from '../context-payload.js';
import type { ContextAssembler } from '../store/context/context-assembler.js';
import type { TaskRecord } from '../task-status.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import type { IntentDocReader } from '../intent/intent-doc-reader-port.js';
import { getIntentFilename, type IntentLang } from '../intent/intent-doc.js';
import {
  buildIntentSnapshot,
  filterIntentSnapshotSections,
  INTENT_SNAPSHOT_SECTION_MAX_CHARS,
  renderIntentSnapshotDoc,
  type IntentSnapshot,
} from '../intent/intent-snapshot.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import {
  hydratePITaskRecord,
  mergePITaskMetadata,
  readPersistedIntentSnapshot,
  serializePITaskMetadata,
} from './pitask-metadata.js';
import { RootCausePromptBuilder } from '../diagnostician/rootcause-prompt-builder.js';
import {
  collectTrustedEvidenceRefs,
  findUnboundEvidenceRefs,
  formatUnboundEvidenceRefErrors,
} from '../diagnostician/evidence-ref-binding.js';
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
  /**
   * SPEC-PD-STRATEGIC-INTENT-ANCHORING-001 v1.2 §6.3: the server-authored
   * strategic basis for THIS task. Resolved from the persisted task input when
   * present, otherwise captured once (and persisted before the model runs).
   *
   * Absent = flag off / no reader / no usable INTENT.md. The prompt then stays
   * byte-identical to the pre-SIA prompt (EP-03: no silent fallback).
   */
  readonly intentSnapshot?: IntentSnapshot;
}

/** Read the persisted diagnostic JSON without assuming TaskRecord types it. */
function readDiagnosticJson(task: TaskRecord | null | undefined): string | null {
  if (!task) return null;
  const raw = task as Record<string, unknown>;
  const { diagnosticJson } = raw;
  return typeof diagnosticJson === 'string' ? diagnosticJson : null;
}

/** The reader returns an absolute path; its filename is the language witness. */
function resolveIntentLangFromPath(intentPath: string): IntentLang {
  return intentPath.includes(getIntentFilename('en')) ? 'en' : 'zh-CN';
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

interface DiagRootCauseRunnerOptions extends PeerRunnerOptions {
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

    // SPEC v1.2 §6.6 / TECH v1.1 §5.4: capture → persist → THEN call the model.
    // Resolved before any expensive work so a failure here costs nothing and
    // can never leave an unpersisted snapshot behind a model invocation.
    const intentSnapshot = await this.resolveIntentSnapshot(task);

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
    return {
      contextHash,
      contextRefs,
      painPayload,
      ...(intentSnapshot !== undefined ? { intentSnapshot } : {}),
    };
  }

  /**
   * Resolve the strategic basis for this task (SPEC v1.2 §6.3/§6.6).
   *
   * Order is the contract:
   *   1. persisted `pi_metadata.intentSnapshot` → use it, never touch INTENT.md
   *   2. corrupted persisted snapshot → fail closed (never silently re-capture)
   *   3. absent + flag on + reader → capture, persist via CAS, then continue
   *   4. anything else → no snapshot (degraded, prompt byte-identical)
   */
  private async resolveIntentSnapshot(task: TaskRecord): Promise<IntentSnapshot | undefined> {
    const persisted = readPersistedIntentSnapshot(readDiagnosticJson(task));
    if (persisted.state === 'corrupt') {
      // rc-3: a corrupted strategic input is a real fault. Re-reading the
      // current INTENT.md would silently substitute a different basis.
      throw new PDRuntimeError(
        'input_invalid',
        `Persisted intent snapshot for task ${task.taskId} is malformed: ${persisted.reason}`,
      );
    }
    if (persisted.state === 'valid') return persisted.snapshot;

    // PRI-468 semantics preserved: flag first, then reader; no reader wired is
    // a startup-time factory issue, not a per-task degradation event.
    let intentGrounding = false;
    if (this.effectiveConfig) {
      intentGrounding = isFeatureEnabled(
        computeFeatureFlagsFromConfig(this.effectiveConfig),
        'intent_engineering',
      );
    }
    if (!intentGrounding || !this.intentDocReader) return undefined;

    const readResult = this.intentDocReader.readIntentDoc();
    if (!readResult.ok || !readResult.doc) {
      // EP-03 / ERR-002: degrade gracefully but observably.
      this.emitEvent('intent_doc_read_failed', task.taskId, {
        reason: readResult.reason ?? 'unknown',
        nextAction: readResult.nextAction ?? 'Check INTENT.md configuration.',
        flagEnabled: readResult.flagEnabled,
        found: readResult.found,
      });
      return undefined;
    }

    const {doc} = readResult;
    const snapshot = buildIntentSnapshot({
      raw: doc.raw,
      contentHash: doc.contentHash,
      capturedAt: new Date().toISOString(),
      lang: resolveIntentLangFromPath(doc.path),
    });

    if (snapshot.sections.some((section) => section.truncated === true)) {
      this.emitEvent('intent_snapshot_truncated', task.taskId, {
        sectionKeys: snapshot.sections.filter((s) => s.truncated === true).map((s) => s.key),
        maxChars: INTENT_SNAPSHOT_SECTION_MAX_CHARS,
        nextAction: 'Shorten the oversized INTENT.md section(s) so the full strategic basis is preserved.',
      });
    }

    if (task.attemptCount > 1) {
      // SPEC §6.6: crashing between read and persist leaves no artifact, so a
      // retry MUST re-capture. That is legitimate but never silent.
      this.emitEvent('intent_snapshot_capture_incomplete', task.taskId, {
        attemptCount: task.attemptCount,
        reason: 'no_persisted_snapshot_on_retry',
        nextAction: 'Stage A re-captured INTENT.md because the previous attempt did not persist a snapshot.',
      });
    }

    return await this.persistIntentSnapshot(task, snapshot);
  }

  /**
   * Persist the captured snapshot as TASK INPUT before the model call.
   *
   * Uses the existing diagnostic-json CAS so a concurrent writer's fields
   * (validator history, revision routing, …) are never clobbered. A lost race
   * is not fatal: the winner's durable snapshot IS the input of record, so we
   * adopt it instead of calling the model with an unpersisted value.
   */
  private async persistIntentSnapshot(
    task: TaskRecord,
    snapshot: IntentSnapshot,
  ): Promise<IntentSnapshot> {
    const piTask = hydratePITaskRecord(task);
    if (!piTask) {
      throw new PDRuntimeError(
        'context_assembly_failed',
        `Task ${task.taskId} has no PI metadata; the intent snapshot cannot be persisted before the model call`,
      );
    }

    const nextDiagnosticJson = serializePITaskMetadata(
      mergePITaskMetadata(piTask, { intentSnapshot: snapshot }),
    );
    const updated = await this.stateManager.updateTaskIfDiagnosticJsonUnchanged(
      task.taskId,
      readDiagnosticJson(task),
      { diagnosticJson: nextDiagnosticJson },
    );
    if (updated) return snapshot;

    // CAS lost — re-read and adopt whatever snapshot the winner persisted.
    const reread = await this.stateManager.getTask(task.taskId);
    const winner = readPersistedIntentSnapshot(readDiagnosticJson(reread));
    if (winner.state === 'valid') {
      this.emitEvent('intent_snapshot_cas_conflict', task.taskId, {
        attemptCount: task.attemptCount,
        adoptedContentHash: winner.snapshot.contentHash,
        nextAction: 'A concurrent writer persisted the task input first; its snapshot is the input of record.',
      });
      return winner.snapshot;
    }
    if (winner.state === 'corrupt') {
      throw new PDRuntimeError(
        'input_invalid',
        `Concurrent write left a malformed intent snapshot on task ${task.taskId}: ${winner.reason}`,
      );
    }

    // No durable snapshot anywhere: the model must NOT run on an unpersisted
    // strategic basis (SPEC §6.6). Retryable — the next attempt re-reads.
    this.emitEvent('intent_snapshot_capture_incomplete', task.taskId, {
      attemptCount: task.attemptCount,
      reason: 'cas_conflict',
      nextAction: 'Retry the stage; no model call was made without a persisted snapshot.',
    });
    throw new PDRuntimeError(
      'context_assembly_failed',
      `Intent snapshot CAS conflict on task ${task.taskId}; the attempt is retried without invoking the model`,
    );
  }

  async invokeRuntime(taskId: string, context: DiagRootCauseContext): Promise<RunHandle> {
    // T-E (PRI-371): Read diagnostician_core_grounding flag from effective config.
    let coreGrounding = false;
    // Pain Diagnosis Persistence: Evidence First Attribution rules in the
    // Stage A prompt. Flag off (default) keeps the prompt byte-identical.
    let evidenceFirstAttribution = false;
    if (this.effectiveConfig) {
      const featureFlags = computeFeatureFlagsFromConfig(this.effectiveConfig);
      coreGrounding = isFeatureEnabled(featureFlags, 'diagnostician_core_grounding');
      evidenceFirstAttribution = isFeatureEnabled(featureFlags, 'pain_diagnosis_persistence');
    }

    // SPEC v1.2 §6.6 / TECH v1.1 §5.4 step 5: the prompt is rebuilt from the
    // SNAPSHOT resolved in buildContext(). INTENT.md is never read a second
    // time, so a retry cannot switch to a newer strategic basis.
    const {intentSnapshot} = context;
    const intentDoc = intentSnapshot
      ? {
          raw: renderIntentSnapshotDoc(intentSnapshot),
          contentHash: intentSnapshot.contentHash,
          path: `.principles/${getIntentFilename(intentSnapshot.lang)}`,
        }
      : undefined;

    const builder = new RootCausePromptBuilder();
    const { message, systemPrompt } = builder.buildPrompt(context.painPayload, {
      outputLanguage: this.resolvedOptions.outputLanguage,
      coreGrounding,
      intentGrounding: intentSnapshot !== undefined,
      intentDoc,
      evidenceFirstAttribution,
    });

    return this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION },
      taskRef: { taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'diag-rootcause-output',
      timeoutMs: this.resolvedOptions.timeoutMs,
      systemPrompt,
    });
  }

  async validateOutput(output: unknown, taskId: string, context: DiagRootCauseContext): Promise<PeerRunnerValidationResult> {
    const result = await this.validator.validate(output, taskId);

    // PRI-1059: structure is not provenance. Bind every cited evidence ref to
    // the context this run actually received; a copied prompt example (or any
    // fabricated reference) must fail before it can become a PIArtifact.
    const trustedRefs = collectTrustedEvidenceRefs(context.painPayload);
    const unbound = findUnboundEvidenceRefs(output, trustedRefs);
    const bindingErrors = formatUnboundEvidenceRefErrors(unbound);

    return {
      valid: result.valid && bindingErrors.length === 0,
      errors: [...result.errors, ...bindingErrors],
      errorCategory: (result.errorCategory as PDErrorCategory | undefined)
        ?? (bindingErrors.length > 0 ? 'output_invalid' : undefined),
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
    context: DiagRootCauseContext,
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
        // SPEC v1.2 §6.3: `intentSnapshot` is a SERVER-authored sibling key of
        // the model output — the model schema has no such field, so it can
        // neither produce nor overwrite it.
        contentJson: JSON.stringify(this.composeArtifactContent(taskId, output, context.intentSnapshot)),
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
      await this.markSucceededFenced(taskId, resultRef);
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
   * Compose the Stage A artifact body (SPEC v1.2 §6.3, TECH v1.1 §3.4).
   *
   * The model output is preserved; the server adds two authoritative facts:
   *   - `intentSnapshot`: the captured strategic basis (narrowed to the
   *     sections the model declared relevant, when it declared any);
   *   - `intentTension.intentDocHash`: ALWAYS the server-computed hash. A
   *     model-reported value is never trusted; a differing value is surfaced
   *     as `intent_hash_mismatch` instead of being silently rewritten.
   */
  private composeArtifactContent(
    taskId: string,
    output: DiagRootCauseOutputV1,
    snapshot: IntentSnapshot | undefined,
  ): Record<string, unknown> {
    if (!snapshot) return { ...output };

    const modelReportedHash = output.intentTension?.intentDocHash;
    if (typeof modelReportedHash === 'string' && modelReportedHash !== snapshot.contentHash) {
      this.emitEvent('intent_hash_mismatch', taskId, {
        snapshotContentHash: snapshot.contentHash,
        modelReportedHash,
        nextAction: 'The server-computed hash is authoritative; the model-reported value was discarded.',
      });
    }

    const intentTension = output.intentTension
      ? { ...output.intentTension, intentDocHash: snapshot.contentHash }
      : undefined;

    return {
      ...output,
      ...(intentTension !== undefined ? { intentTension } : {}),
      intentSnapshot: filterIntentSnapshotSections(
        snapshot,
        output.intentTension?.relatedIntentFields ?? [],
      ),
    };
  }

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
