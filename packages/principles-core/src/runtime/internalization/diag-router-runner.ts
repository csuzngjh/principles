/**
 * DiagRouterRunner — Stage C runner for the split diagnostician pipeline.
 *
 * Receives both Stage A (Root Cause) and Stage B (Distiller) artifacts and
 * produces the final DiagnosticianOutputV2 — the ONLY production diagnostician
 * contract (PRI-1146 V2 Only / Clean Break; SPEC v0.6).
 *
 * Unlike Stages A and B which only write PIArtifacts, Stage C commits via
 * DiagnosticianCommitter (same as the historical monolithic runner) and
 * persists the trusted-context receipt + read-only association validation
 * alongside the output inside the artifact envelope.
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
 * @see PRI-1146
 * @see BasePeerRunner in runner/base-peer-runner.ts
 */

import { createHash } from 'node:crypto';
import { RUNTIME_CONTRACT_SCHEMA_VERSION } from '../schema-version.js';
import { Value } from '@sinclair/typebox/value';
import { verifyRouterContextReceipt, type RouterTrustedPrinciple, type RouterTrustedPrincipleSource } from './router-context-evidence.js';
import type { RunHandle } from '../runtime-protocol.js';
import type { DiagnosticianOutputV2 } from '../diagnostician-output.js';
import { DiagnosticianOutputV2Schema } from '../diagnostician-output.js';
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
import { DefaultDiagnosticianValidator } from '../runner/default-validator.js';
import { validateDiagnosticianAssociations } from '../diagnostician-association-validation.js';
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
  /**
   * PRI-1146 / SPEC v0.6 §5: canonical principles the system exposes to the
   * model for this run, read BEFORE the model call from the authoritative
   * ledger. Empty when the ledger holds no eligible principles (a proven
   * empty exposure). When provability itself fails, `trustedPrinciples` is
   * empty AND `trustedPrinciplesUnavailable` carries the typed reason — the
   * receipt then records `unavailable` and canonical associations stay
   * unresolved rather than guessed.
   */
  readonly trustedPrinciples: readonly RouterTrustedPrinciple[];
  readonly trustedPrinciplesUnavailable?: { reason: 'ledger_unavailable' | 'ledger_corrupt' | 'source_not_configured'; nextAction: string };
  invocationEvidence?: {
    taskId: string;
    message: string;
    messageDigest: string;
    /**
     * SHA-256 of the EXACT effective system prompt the runtime adapter handed
     * to the model provider — all prompt layers merged by the adapter's single
     * merge path (PRI-1146 P1-02). Never derived from the base layer alone.
     */
    systemPromptDigest: string;
    predecessorDigests: { artifactId: string; contentDigest: string }[];
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
  /**
   * PRI-1146: trusted canonical principle source. Required — the router must
   * decide the exposure allowlist (or record a typed unavailable) BEFORE the
   * model call; there is no legitimate "no source" production state. The
   * runtime factory and CLI paths inject the Principle Ledger adapter; tests
   * inject deterministic doubles.
   */
  readonly trustedPrincipleSource: RouterTrustedPrincipleSource;
}

// ── Options ──────────────────────────────────────────────────────────────────

interface DiagRouterRunnerOptions extends PeerRunnerOptions {
  /** Effective PD config for feature flag resolution (ADR-0019). */
  readonly effectiveConfig?: EffectivePdConfig;
}

// ── Envelope association evaluation (module-level, no runner state) ──────────

/**
 * SPEC v0.6 §6/§7 — run the pure association structural validation against
 * the exposure actually recorded in the receipt, for the artifact envelope.
 * Read-only: the result never gates the commit (a hallucinated canonical
 * target degrades that rule's association to unresolved, it does not discard
 * the diagnosis) and never authorizes binding or generation.
 */
function evaluateAssociationsForEnvelope(
  output: DiagnosticianOutputV2,
  canonicalPrinciples: { status: 'available'; principles: readonly RouterTrustedPrinciple[] } | { status: 'unavailable'; reason: string; nextAction: string },
  evidenceRefs: string[],
): ReturnType<typeof validateDiagnosticianAssociations> {
  if (canonicalPrinciples.status !== 'available') {
    return {
      ok: false,
      reason: 'context_invalid',
      nextAction: canonicalPrinciples.nextAction,
    };
  }
  return validateDiagnosticianAssociations(output, {
    principleIds: canonicalPrinciples.principles.map((p) => p.principleId),
    evidenceRefs,
  });
}

// ── DiagRouterRunner ─────────────────────────────────────────────────────────

/**
 * Stage C runner for the split diagnostician pipeline.
 *
 * Produces the final DiagnosticianOutputV2 by routing the distilled principle
 * from Stage B into the appropriate recommendation taxonomy kind(s). Commits
 * via DiagnosticianCommitter with the trusted-context receipt and read-only
 * association validation embedded in the artifact envelope.
 *
 * @see PRI-372
 * @see PRI-1146
 */
export class DiagRouterRunner extends BasePeerRunner<DiagRouterContext, DiagnosticianOutputV2> {
  private readonly committer: DiagnosticianCommitter;
  private readonly defaultValidator: DefaultDiagnosticianValidator;
  private readonly trustedPrincipleSource: RouterTrustedPrincipleSource;

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
    this.trustedPrincipleSource = deps.trustedPrincipleSource;
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

    // PRI-1146 / SPEC v0.6 §5: assemble the trusted canonical principle
    // exposure BEFORE the model call. Read failures are typed and observable —
    // the run proceeds with an `unavailable` receipt rather than guessing an
    // allowlist (canonical associations then stay unresolved).
    let trustedPrinciples: readonly RouterTrustedPrinciple[] = [];
    let trustedPrinciplesUnavailable: DiagRouterContext['trustedPrinciplesUnavailable'];
    try {
      const exposure = this.trustedPrincipleSource.readTrustedPrinciples();
      if (exposure.status === 'ok') {
        trustedPrinciples = exposure.principles;
      } else {
        trustedPrinciplesUnavailable = {
          reason: exposure.reason,
          nextAction: 'Repair the Principle Ledger read path, then re-run the diagnosis; canonical principle associations stay unresolved until the exposure is provable.',
        };
        this.emitEvent('trusted_context_unavailable', taskId, { reason: exposure.reason });
      }
    } catch (err) {
      // The port itself threw (not a typed unavailable) — fail loud, do not
      // silently treat a broken source as an empty ledger.
      throw new PDRuntimeError(
        'input_invalid',
        `Trusted principle source threw while assembling the router context for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      trustedPrinciples,
      ...(trustedPrinciplesUnavailable ? { trustedPrinciplesUnavailable } : {}),
    };

    return context;
  }

  async invokeRuntime(taskId: string, context: DiagRouterContext): Promise<RunHandle> {
    const builder = new RouterPromptBuilder();
    const { message, systemPrompt } = builder.buildPrompt(
      {
        rootCauseArtifactId: context.rootCauseArtifactId,
        rootCauseOutput: context.rootCauseOutput,
        distillerArtifactId: context.distillerArtifactId,
        distillerOutput: context.distillerOutput,
        // PRI-1146 P1-02 / §5.3: the exposure state travels as structured
        // low-trust data in the message — available (possibly empty) vs typed
        // unavailable are distinct payload states, never rendered into the
        // static system prompt.
        trustedContext: context.trustedPrinciplesUnavailable
          ? {
            status: 'unavailable',
            reason: context.trustedPrinciplesUnavailable.reason,
            nextAction: context.trustedPrinciplesUnavailable.nextAction,
          }
          : { status: 'available', principles: context.trustedPrinciples },
      },
      {
        outputLanguage: this.resolvedOptions.outputLanguage,
      },
    );

    // System-owned evidence from the exact message submitted, never model output.
    // The trusted allowlist travels INSIDE the message (the runtime adapter
    // ignores StartRunInput.contextItems), so the message digest below is the
    // exposure proof.
    context.invocationEvidence = {
      taskId,
      message,
      messageDigest: createHash('sha256').update(message).digest('hex'),
      // Filled from the runtime handle below — the adapter merges profile
      // layers, so only it can attest the system prompt the provider received.
      systemPromptDigest: '',
      predecessorDigests: [
        { artifactId: context.rootCauseArtifactId, contentDigest: createHash('sha256').update(JSON.stringify(context.rootCauseOutput)).digest('hex') },
        { artifactId: context.distillerArtifactId, contentDigest: createHash('sha256').update(JSON.stringify(context.distillerOutput)).digest('hex') },
      ],
    };
    const runHandle = await this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION },
      taskRef: { taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'diagnostician-output',
      timeoutMs: this.resolvedOptions.timeoutMs,
      systemPrompt,
    });

    // PRI-1146 P1-02: bind the receipt to the provider-visible prompt. The
    // adapter is the only component that knows every merged layer; when it
    // cannot attest the effective prompt there is no honest digest to record,
    // so fail loud instead of hashing the base layer and claiming provenance.
    const providerPromptDigest = runHandle.systemPromptDigest;
    if (typeof providerPromptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(providerPromptDigest)) {
      throw new PDRuntimeError(
        'input_invalid',
        `Runtime adapter did not report the effective system prompt digest for task ${taskId}; the router receipt cannot bind the prompt actually sent to the provider.`,
      );
    }
    context.invocationEvidence.systemPromptDigest = providerPromptDigest;
    return runHandle;
  }

  /**
   * P2-01: persist the exact router message so a NEW process can rebuild the
   * invocation evidence and run the full receipt verification (not just a
   * structural read) from immutable persisted data.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected override getInvocationInputPayload(context: DiagRouterContext): string | undefined {
    return context.invocationEvidence?.message;
  }

  async validateOutput(output: unknown, taskId: string, _context: DiagRouterContext): Promise<PeerRunnerValidationResult> {
    // Step 1: TypeBox schema check (V2 — the only contract; a V1 payload
    // missing schemaVersion/recommendationRef fails here, no fallback).
    if (!Value.Check(DiagnosticianOutputV2Schema, output)) {
      const schemaErrors = [...Value.Errors(DiagnosticianOutputV2Schema, output)]
        .slice(0, 5)
        .map((e) => `${e.path}: ${e.message}`);
      return {
        valid: false,
        errors: schemaErrors,
        errorCategory: 'output_invalid',
      };
    }

    // Step 2: Semantic + artifact-local association validation (ASSC-1..4)
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
    output: DiagnosticianOutputV2,
    task: TaskRecord,
    contextHash: string,
    context: DiagRouterContext,
  ): Promise<PeerRunnerResult<DiagnosticianOutputV2>> {
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
    const evidence = context.invocationEvidence;
    if (!evidence || evidence.taskId !== taskId) {
      throw new PDRuntimeError('input_invalid', 'Router invocation context evidence is missing or belongs to another task');
    }
    // Evidence refs actually exposed this run = the Stage A evidence sourceRefs
    // shipped inside the router prompt input (digest-bound to the message).
    const exposedEvidenceRefs = [...new Set(context.rootCauseOutput.evidence.map((ev) => ev.sourceRef))];
    const canonicalPrinciples = context.trustedPrinciplesUnavailable
      ? {
        status: 'unavailable' as const,
        reason: context.trustedPrinciplesUnavailable.reason,
        nextAction: context.trustedPrinciplesUnavailable.nextAction,
      }
      : {
        status: 'available' as const,
        principles: context.trustedPrinciples,
      };
    const routerContentJson = JSON.stringify({
      ...output,
      trustedContextReceipt: {
        schemaVersion: 'router-context-v2',
        taskId,
        runId,
        outputSchemaRef: 'diagnostician-output',
        contextHash,
        messageDigest: evidence.messageDigest,
        systemPromptDigest: evidence.systemPromptDigest,
        predecessorDigests: evidence.predecessorDigests,
        evidenceRefs: exposedEvidenceRefs,
        canonicalPrinciples,
      },
      // Read-only association validation against the trusted exposure (SPEC
      // v0.6 §6/§7): structural results only — semanticCorrectness stays
      // not_evaluated and nothing here authorizes binding or generation.
      associationValidation: evaluateAssociationsForEnvelope(output, canonicalPrinciples, exposedEvidenceRefs),
    });
    // Check the persisted shape at the real write boundary.
    const persistedEnvelope: unknown = JSON.parse(routerContentJson);
    const receiptCheck = verifyRouterContextReceipt(persistedEnvelope, {
      taskId, runId, contextHash, message: evidence.message, systemPromptDigest: evidence.systemPromptDigest,
      predecessors: [
        { artifactId: context.rootCauseArtifactId, content: context.rootCauseOutput },
        { artifactId: context.distillerArtifactId, content: context.distillerOutput },
      ],
      exposed: { ...canonicalPrinciples, evidenceRefs: exposedEvidenceRefs },
    });
    if (receiptCheck.status !== 'available') {
      throw new PDRuntimeError('input_invalid', `Invalid router context receipt: ${receiptCheck.reason}`);
    }
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

    // 2b. Dual-write the DiagnosticianOutputV2 into pi_artifacts (PRI-667).
    // The committer's legacy `artifacts` row is the candidate-intake source;
    // the downstream internalization runners read their predecessors ONLY
    // from pi_artifacts — without this row the evaluator cannot resolve its
    // artificer dependency artifact (observed live 2026-09-03 ×5 chains and
    // in the PRI-653 lab ×2). Same persistence shape as the
    // diag_rootcause/diag_distiller writers, keeping the top-level `evidence`
    // field readable. Idempotent via the (source_task_id, artifact_kind) upsert.
    try {
      const lineageResult = await this.resolveLineageArtifactIds(taskId);
      const now = new Date().toISOString();
      await this.artifactStore.upsertArtifact({
        artifactId: `pi-art-${taskId}-${runId}`,
        artifactKind: 'principle',
        sourceTaskId: taskId,
        lineageArtifactIds: lineageResult.ids,
        validationStatus: 'pending',
        contentJson: routerContentJson,
        createdAt: now,
        updatedAt: now,
      });
    } catch (piWriteErr) {
      this.emitEvent('artifact_write_failed', taskId, {
        runId,
        errorMessage: piWriteErr instanceof Error ? piWriteErr.message : String(piWriteErr),
      });
      return this.retryOrFail({
        taskId,
        task,
        errorCategory: 'artifact_commit_failed',
        failureReason: `PIArtifact dual-write failed: ${piWriteErr instanceof Error ? piWriteErr.message : String(piWriteErr)}`,
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
        recommendationRef: rec.recommendationRef,
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
    // PRI-1146: the legacy "re-inject taskId if stripped" shim is REMOVED.
    // The V2 root is closed (`additionalProperties: false`) and has no
    // taskId field — lineage is owned by the runner/TaskRecord and no
    // production consumer reads it from the diagnostician output. Injecting
    // it would fail V2 schema validation for every run.

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
      // (SPEC §18.2). Only copy it through when Stage A actually produced a
      // defined value. If Stage A did not produce one (absent or
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

  protected override emitSuccessTelemetry(taskId: string, output: DiagnosticianOutputV2, _context: DiagRouterContext): void {
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
