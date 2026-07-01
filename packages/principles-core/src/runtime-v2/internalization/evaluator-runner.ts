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
import type {
  EvaluatorOutputV1,
  EvaluatorOutputV2,
  EvaluatorValidator,
  EvaluatorAdversarialResult,
  AdversarialFailedCase,
  AdversarialCase,
} from './evaluator-output.js';
import { isEvaluatorOutputV2 } from './evaluator-output.js';
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
// PRI-426: single-round adversarial sandbox replay in succeedTask.
import { evaluateRefinerRuleHostGate, type RefinerRuleHostGateDeps } from './refiner-rulehost-gate.js';
import { adversarialCasesToGoldenTrace } from './adversarial-case.js';
import { buildGoldenTraceFromArtificer } from '../golden-trace.js';
import type { GoldenTrace, GoldenTraceCase } from '../golden-trace.js';
// PRI-485 Phase 6: auto-generate 5 v2 adversarial cases (unavailable/truncation/
// alias/path/combination) to defend against false-positive blocks.
import { generateV2ContextAdversarialCases } from './v2-adversarial-cases.js';
import { canonicalizeToolKind } from './rule-context-v2.js';

// ── Evaluator-specific context ────────────────────────────────────────────────

/** Context built by EvaluatorRunner.buildContext() and consumed by invokeRuntime(). */
interface EvaluatorContext {
  readonly contextHash: string;
  readonly artificerArtifact: string | null;
  readonly sourceArtificerArtifactId: string | null;
  /**
   * Scribe principle artifact contentJson (RuleHost MVP Activation, PRD Decision 12).
   * Loaded so the evaluator LLM can judge code intentConsistency/scopePrecision
   * against the original principle text. Null when no scribe artifact is resolvable
   * (scribeArtifactId missing/malformed or upstream artifact unavailable).
   */
  readonly scribeArtifact: string | null;
  readonly sourceScribeArtifactId: string | null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extract scribeArtifactId from an artificer artifact's contentJson (PRD Decision 12).
 * The contentJson is untrusted — parsed defensively with type guards, never as-cast
 * (Runtime Contract Rule 1/2/5). Returns null when the field is absent or malformed;
 * callers treat null as "code review degraded (no principle text)".
 *
 * Looks in two locations:
 *   1. top-level sourceTrace.scribeArtifactId (ArtificerRuleOutput contract)
 *   2. top-level sourceScribeArtifactId (ArtificerRuleOutput contract)
 */
function extractScribeArtifactId(artificerContentJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(artificerContentJson);
  } catch {
    return null;
  }
  if (!isRecordValue(parsed)) return null;

  // sourceTrace.scribeArtifactId
  const trace = Object.hasOwn(parsed, 'sourceTrace') ? parsed.sourceTrace : undefined;
  if (isRecordValue(trace)) {
    const fromTrace = Object.hasOwn(trace, 'scribeArtifactId') ? trace.scribeArtifactId : undefined;
    if (typeof fromTrace === 'string' && fromTrace.trim() !== '') return fromTrace;
  }
  // top-level sourceScribeArtifactId
  const direct = Object.hasOwn(parsed, 'sourceScribeArtifactId') ? parsed.sourceScribeArtifactId : undefined;
  if (typeof direct === 'string' && direct.trim() !== '') return direct;

  return null;
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

/**
 * EvaluatorRunner options. Extends PeerRunnerOptions with an optional
 * RuleHost sandbox gate deps (PRI-426). When `gateDeps` is provided AND the
 * evaluator output is V2 (code-bearing), succeedTask runs a single-round
 * adversarial sandbox replay and populates `adversarialResult`.
 *
 * When `gateDeps` is absent, V2 outputs still validate but no replay runs —
 * this preserves backward compatibility for callers not yet wired to the
 * sandbox (e.g. V1-only test fixtures, pre-Phase-6 assembly).
 */
export interface EvaluatorRunnerOptions extends PeerRunnerOptions {
  readonly gateDeps?: RefinerRuleHostGateDeps;
}

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
  /**
   * Optional RuleHost sandbox gate deps (PRI-426). When present and the output
   * is V2, succeedTask runs a single adversarial sandbox replay. Absent = no
   * replay (backward compatible).
   */
  private readonly gateDeps: RefinerRuleHostGateDeps | null;

  constructor(deps: EvaluatorRunnerDeps, options: EvaluatorRunnerOptions) {
    super(deps, options, {
      runnerName: 'evaluator',
      expectedTaskKind: 'evaluator',
      defaultAgentId: 'evaluator',
      resultRefPrefix: 'evaluator',
    });
    this.validator = deps.validator;
    this.gateDeps = options.gateDeps ?? null;
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

        // PRD Decision 12: resolve the scribe artifact so the evaluator LLM can
        // judge code intentConsistency/scopePrecision against the principle text.
        // Extract scribeArtifactId from the artificer's sourceTrace (untrusted
        // contentJson — validated via type guards, never as-cast; Runtime Rule 1/2).
        const scribeRef = extractScribeArtifactId(firstArtifact.contentJson);
        let scribeContent: string | null = null;
        if (scribeRef) {
          const scribeArtifact = await this.artifactStore.getArtifactById(scribeRef);
          if (scribeArtifact && scribeArtifact.artifactKind === 'principle') {
            scribeContent = scribeArtifact.contentJson;
          } else {
            this.emitEvent('scribe_artifact_unresolvable', taskId, {
              scribeArtifactId: scribeRef,
              reason: scribeArtifact ? `wrong kind: ${scribeArtifact.artifactKind}` : 'not found',
              nextAction: 'code_review_degraded_without_principle_text',
            });
          }
        }

        const contextRefs: string[] = scribeContent && scribeRef
          ? [artifactRef, scribeRef]
          : [artifactRef];
        return {
          contextHash: BasePeerRunner.hashContextRefs(contextRefs),
          artificerArtifact: firstArtifact.contentJson,
          sourceArtificerArtifactId: firstArtifact.artifactId,
          scribeArtifact: scribeContent,
          sourceScribeArtifactId: scribeRef,
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

    // PRD Decision 12: pass the scribe principle text so the LLM can judge
    // code intentConsistency/scopePrecision. Null when unresolvable (V1 artificer
    // output, or scribe artifact missing) — the prompt builder accepts undefined.
    let parsedScribeArtifact: unknown = undefined;
    if (context.scribeArtifact) {
      try {
        parsedScribeArtifact = JSON.parse(context.scribeArtifact);
      } catch {
        parsedScribeArtifact = context.scribeArtifact;
      }
    }

    const builder = new EvaluatorPromptBuilder();
    const { message } = builder.buildPrompt({
      taskId,
      contextHash: context.contextHash,
      artificerArtifact: parsedArtificerArtifact,
      scribeArtifact: parsedScribeArtifact,
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
    const result = await this.validator.validate(output, taskId, context.sourceArtificerArtifactId ?? undefined);

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

    // ── PRI-426: single-round adversarial sandbox replay ──
    // Runs only when (a) the output is V2 (code-bearing), (b) gateDeps is
    // injected, and (c) passive review passed (LLM short-circuits to
    // needs_revision when any of the 3 dimensions fail, so by the time we get
    // here with decision='approved' the passive review already passed).
    //
    // PRI-423 contract: adversarialCasesToGoldenTrace yields an all-negative
    // trace. We MUST merge ≥1 positive case from the Artificer golden trace
    // before replaying, otherwise the merged trace fails validateGoldenTrace.
    //
    // This block never throws into the caller — a sandbox/gate failure degrades
    // to adversarialResult.passed=false with a structured reason (ERR-018).
    // The principle artifact is already persisted, so prompt-channel fallback
    // remains available regardless of replay outcome (PRD Decision 11d §h).
    let finalOutput: EvaluatorOutputV1 = output;
    if (isEvaluatorOutputV2(output) && this.gateDeps) {
      const replayOutcome = await this.runAdversarialReplay(output, taskId, runId, context);
      if (replayOutcome.updatedOutput) {
        finalOutput = replayOutcome.updatedOutput;
        await this.stateManager.updateRunOutput(runId, JSON.stringify(finalOutput));
        // Re-persist the artifact with the populated adversarialResult so
        // downstream readers (Phase 6 assembly, orchestrator retry) see it.
        try {
          await this.artifactStore.upsertArtifact({
            artifactId,
            artifactKind: 'principle',
            sourceTaskId: taskId,
            lineageArtifactIds,
            validationStatus: 'pending',
            contentJson: JSON.stringify(finalOutput),
            createdAt: now,
            updatedAt: new Date().toISOString(),
          });
        } catch (replayPersistErr) {
          // Non-fatal: the principle artifact is already written. Log and
          // continue — adversarialResult is still on finalOutput in memory.
          this.emitEvent('adversarial_result_persist_failed', taskId, {
            runId,
            errorMessage: replayPersistErr instanceof Error ? replayPersistErr.message : String(replayPersistErr),
          });
        }
      }
    }

    // ── PRI-427: rule artifact assembly ──
    // When the evaluator output is V2 AND the adversarial replay passed, write
    // a second artifact with artifactKind='rule' carrying the executable code
    // + golden trace + gate decision, then mark it 'validated' so the downstream
    // RuleHostWriter.canActivate path accepts it.
    //
    // PRD Decision 5 contract:
    //   - rule artifact goldenTrace = Artificer's FULL trace (buildGoldenTraceFromArtificer),
    //     NOT the adversarial replay trace. The adversarial trace was only used
    //     to TEST the code in PRI-426; enforcement uses the production trace.
    //   - ruleHostGateDecision must be 'accepted_shadow' for RuleHostWriter to
    //     accept (rule-host-writer.ts extractRuleHostGateDecision).
    //   - Assembly failure is non-fatal: principle artifact is already written,
    //     prompt-channel fallback remains available (PRD Decision 5 degradation).
    let ruleArtifactId: string | null = null;
    if (isEvaluatorOutputV2(finalOutput) && finalOutput.adversarialResult?.passed === true) {
      ruleArtifactId = await this.assembleRuleArtifact(finalOutput, taskId, runId, context, lineageArtifactIds);
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
      evaluationDecision: finalOutput.evaluation.decision,
      evaluationScore: finalOutput.evaluation.score,
      ruleArtifactId,
    });

    return {
      status: 'succeeded',
      taskId,
      runId,
      artifactId,
      resultRef,
      contextHash,
      output: finalOutput,
      attemptCount: task.attemptCount,
    };
  }

  // ── Optional hooks ──────────────────────────────────────────────────────────

  /**
   * Re-inject taskId if stripped by stripLineageFields (PRI-272 / ERR-008).
   * Only fill when absent via Object.hasOwn — present-but-falsy values
   * must reach validation and fail loud (Runtime Contract Rule 3).
   *
   * generatedAt override is handled by the base class — subclasses must call
   * super.postFetchTransform() to inherit it.
   */
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown, _context: EvaluatorContext): void {
    super.postFetchTransform(taskId, untrustedOutput, _context);
    injectRunnerLineageIfAbsent(untrustedOutput, 'taskId', taskId);
  }

  protected override emitSuccessTelemetry(taskId: string, output: EvaluatorOutputV1): void {
    this.emitEvent('decision_recorded', taskId, {
      evaluationDecision: output.evaluation.decision,
      evaluationScore: output.evaluation.score,
    });
  }

  /**
   * Check lineage strip contract after validation passes.
   * Validates sourceTrace.scribeArtifactId consistency (ERR-004, ERR-008).
   */
  protected override checkLineageIntegrity(taskId: string, output: EvaluatorOutputV1, _context: EvaluatorContext): void {
    // sourceTrace.artificerArtifactId must match sourceArtificerArtifactId
    if (output.sourceTrace.artificerArtifactId !== output.sourceArtificerArtifactId) {
      this.emitEvent('lineage_integrity_violation', taskId, {
        sourceArtificerArtifactId: output.sourceArtificerArtifactId,
        traceArtificerArtifactId: output.sourceTrace.artificerArtifactId,
        reason: 'sourceArtificerArtifactId_and_sourceTrace_artificerArtifactId_mismatch',
      });
    }
  }

  // ── PRI-426: adversarial sandbox replay ─────────────────────────────────────

  /**
   * Run a single-round adversarial sandbox replay on the evaluator's V2 output
   * (PRD Decision 11d). Pure orchestration of pure functions:
   *   1. Skip if passive review failed (decision !== 'approved' is the LLM's
   *      short-circuit signal — no code to defend).
   *   2. Skip if no adversarialCases present (V2 with codeReview only).
   *   3. Convert adversarialCases → GoldenTrace (all negative, PRI-423).
   *   4. Merge ≥1 positive case from the Artificer golden trace. If the
   *      artificer artifact has no goldenTraceCases (V1 mismatch), degrade:
   *      skip replay with telemetry — do NOT crash.
   *   5. Invoke evaluateRefinerRuleHostGate via injected gateDeps.
   *   6. Populate adversarialResult from the gate result.
   *
   * Never throws — all failure modes degrade to a returned result with a
   * structured reason (ERR-018). The caller persists the updated output.
   */
  // eslint-disable-next-line @typescript-eslint/max-params
  private async runAdversarialReplay(
    output: EvaluatorOutputV2,
    taskId: string,
    runId: string,
    context: EvaluatorContext,
  ): Promise<{ readonly updatedOutput: EvaluatorOutputV2 | null }> {
    // gateDeps is non-null here — the caller only invokes this method when
    // this.gateDeps is set. Bind to a local to avoid re-asserting.
    // eslint-disable-next-line @typescript-eslint/prefer-destructuring
    const gateDeps = this.gateDeps;
    if (!gateDeps) {
      return { updatedOutput: null };
    }
    // (1) Passive review short-circuit: the LLM emits decision='needs_revision'
    // when any of intentConsistency/scopePrecision/traceCoverage fails. Only
    // replay when the LLM judged the code worth defending. This check is
    // defensive — by PRD contract the prompt instructs the LLM to short-circuit,
    // but we don't trust the LLM to be the sole gate (Runtime Contract Rule 3).
    if (output.evaluation.decision !== 'approved') {
      return { updatedOutput: null };
    }

    // (2) Resolve the Artificer artifact early — we need it both to derive
    // the v2 adversarial spec (PRI-485) and to merge positive cases (PRI-423).
    if (!context.artificerArtifact) {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'no_artificer_artifact_in_context',
        nextAction: 'verify_buildContext_resolves_artificer_artifact',
      });
      return { updatedOutput: null };
    }

    const artificerParsed = this.parseArtificerArtifact(context.artificerArtifact);
    if (!artificerParsed) {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'artificer_artifact_unparseable',
        nextAction: 'verify_artificer_artifact_contentJson',
      });
      return { updatedOutput: null };
    }

    const { implementationCode, goldenTraceCases, affectedTools } = artificerParsed;
    if (typeof implementationCode !== 'string' || implementationCode.trim() === '') {
      // Artificer output is V1 (no code) but the evaluator emitted V2. This is
      // a mismatch — degrade rather than replay against missing code.
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'artificer_artifact_has_no_implementation_code',
        nextAction: 'verify_artificer_l2_adapter_emitted_v2',
      });
      return { updatedOutput: null };
    }

    // Merge positive cases from the Artificer golden trace into the adversarial
    // trace. buildGoldenTraceFromArtificer validates each case structurally
    // (Runtime Contract Rule 4) and returns ok=false on any malformed entry.
    const positiveCases = this.extractPositiveCases(goldenTraceCases);
    if (positiveCases.length === 0) {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: 'no_positive_case_in_artificer_golden_trace',
        nextAction: 'verify_artificer_emitted_at_least_one_positive_case',
      });
      return { updatedOutput: null };
    }

    // (3) PRI-485 Phase 6: auto-generate 5 v2 adversarial cases from the
    // Artificer's affectedTools + first positive case's path. These defend
    // against the most common false-positive patterns (unavailable/truncation/
    // alias/path/combination). Degrade with telemetry (rc-9) if the spec
    // cannot be derived — LLM-supplied adversarialCases still replay.
    const llmCases = output.adversarialCases ?? [];
    const v2Cases = this.generateV2CasesFromArtificer(affectedTools, positiveCases, taskId, runId);
    const mergedAdversarialCases: readonly AdversarialCase[] = [...v2Cases, ...llmCases];

    // (4) No adversarial cases (neither v2-generated nor LLM-supplied) →
    // nothing to replay. codeReview may still be present (passive review only).
    if (mergedAdversarialCases.length === 0) {
      return { updatedOutput: null };
    }

    // (5) Convert the merged adversarial cases to an all-negative GoldenTrace.
    const conversion = adversarialCasesToGoldenTrace(mergedAdversarialCases);
    if (!conversion.ok) {
      // Validator already accepted adversarialCases, so a conversion failure
      // here is a contract drift between validator and converter. Degrade loud.
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: `adversarial_conversion_failed: ${conversion.reason}`,
        nextAction: 'verify_adversarial_case_validator_alignment',
      });
      return { updatedOutput: null };
    }

    const mergedTrace: GoldenTrace = {
      traceId: `golden-trace-evaluator-replay-${taskId}-${Date.now().toString(36)}`,
      sourceArtifactId: context.sourceArtificerArtifactId ?? undefined,
      version: 1,
      createdAt: new Date().toISOString(),
      cases: [...positiveCases, ...conversion.trace.cases],
    };

    // (6) Invoke the gate. evaluateRefinerRuleHostGate is a pure function that
    // catches its own sandbox throws internally (rejected_runtime_error), so
    // this await cannot throw on sandbox failure — but we guard anyway for
    // defense-in-depth (ERR-018: trust boundary at injected deps).
    let gateResult;
    try {
      gateResult = evaluateRefinerRuleHostGate(
        { code: implementationCode, goldenTrace: mergedTrace },
        gateDeps,
      );
    } catch (gateErr) {
      this.emitEvent('adversarial_replay_skipped', taskId, {
        runId,
        reason: `gate_invocation_threw: ${gateErr instanceof Error ? gateErr.message : String(gateErr)}`,
        nextAction: 'verify_gate_deps_implementation',
      });
      const failedResult: EvaluatorAdversarialResult = {
        passed: false,
        failedCases: [],
      };
      return {
        updatedOutput: { ...output, adversarialResult: failedResult },
      };
    }

    this.emitEvent('adversarial_replay', taskId, {
      runId,
      gateDecision: gateResult.decision,
      caseCount: mergedTrace.cases.length,
      failedCaseCount: gateResult.sandboxResult.failedCases.length,
    });

    // (7) Populate adversarialResult from the gate result.
    const accepted = gateResult.decision === 'accepted_shadow';
    const failedCases: AdversarialFailedCase[] = accepted
      ? []
      : this.mapFailedCases(gateResult, mergedAdversarialCases);

    const adversarialResult: EvaluatorAdversarialResult = {
      passed: accepted,
      failedCases,
    };

    return {
      updatedOutput: { ...output, adversarialResult },
    };
  }

  /**
   * Parse the Artificer artifact contentJson defensively (Runtime Contract
   * Rule 1/2/5). Returns null on any structural issue — the caller degrades.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private parseArtificerArtifact(
    contentJson: string,
  ): {
    readonly implementationCode: unknown;
    readonly goldenTraceCases: unknown;
    readonly affectedTools: unknown;
    readonly requiresContextVersion: unknown;
    readonly evidenceRefs: unknown;
  } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contentJson);
    } catch {
      return null;
    }
    if (!EvaluatorRunner.isRecord(parsed)) return null;
    return {
      implementationCode: parsed.implementationCode,
      goldenTraceCases: parsed.goldenTraceCases,
      affectedTools: parsed.affectedTools,
      requiresContextVersion: parsed.requiresContextVersion,
      evidenceRefs: parsed.evidenceRefs,
    };
  }

  /**
   * Extract a principle ID from a PIArtifactRecord. Mirrors the logic in
   * activation/low-risk-writers.ts extractPrincipleId() but operates on
   * PIArtifactRecord (internalization module type) instead of PIArtifactSnapshot
   * (activation module type). Kept inline to avoid a cross-module runtime
   * dependency on the activation module.
   *
   * Resolution order:
   *   1. record.sourcePrincipleId (top-level field)
   *   2. parsed.principleId (contentJson)
   *   3. parsed.sourcePrincipleId (contentJson)
   *   4. parsed.principleDraft.title (contentJson — scribe output shape)
   */
  private static extractPrincipleIdFromArtifact(
    record: { sourcePrincipleId?: string; contentJson: string },
  ): string | undefined {
    if (typeof record.sourcePrincipleId === 'string' && record.sourcePrincipleId.trim() !== '') {
      return record.sourcePrincipleId.trim();
    }
    try {
      const parsed: unknown = JSON.parse(record.contentJson);
      if (!EvaluatorRunner.isRecord(parsed)) return undefined;
      const {principleId} = parsed;
      if (typeof principleId === 'string' && principleId.trim() !== '') {
        return principleId.trim();
      }
      const {sourcePrincipleId} = parsed;
      if (typeof sourcePrincipleId === 'string' && sourcePrincipleId.trim() !== '') {
        return sourcePrincipleId.trim();
      }
      const {principleDraft} = parsed;
      if (EvaluatorRunner.isRecord(principleDraft)) {
        const {title} = principleDraft;
        if (typeof title === 'string' && title.trim() !== '') {
          return title.trim();
        }
      }
    } catch {
      // contentJson unparseable — fall through
    }
    return undefined;
  }

  /**
   * Extract structurally-valid positive GoldenTraceCases from the Artificer
   * goldenTraceCases array. Uses buildGoldenTraceFromArtificer (which re-
   * validates each case) and filters for kind='positive'. Returns [] when
   * the input is missing/malformed — the caller degrades to a skip (ERR-069:
   * never trust unvalidated candidates).
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private extractPositiveCases(rawCases: unknown): GoldenTraceCase[] {
    if (!Array.isArray(rawCases)) return [];
    const buildResult = buildGoldenTraceFromArtificer({ cases: rawCases });
    if (!buildResult.ok) return [];
    return buildResult.trace.cases.filter((c) => c.kind === 'positive');
  }

  /**
   * PRI-485 Phase 6: derive the v2 adversarial case spec from the Artificer
   * artifact and generate the 5 canonical v2 cases.
   *
   * Spec derivation:
   *   - toolName: the first entry in `affectedTools` (validated as a non-empty
   *     string array). Falls back to the first positive case's toolName when
   *     affectedTools is missing/malformed — the rule still governs that tool.
   *   - targetPath: the first positive case's `params.path` (validated as a
   *     non-empty string). When absent, degrade with telemetry (rc-9) and
   *     return [] — v2 cases cannot be path-realistic without a target path.
   *   - canonicalKind: canonicalizeToolKind(toolName) — pure lookup.
   *
   * Never throws. All malformed inputs degrade to [] with a telemetry event
   * carrying a structured `reason` + `nextAction` (Runtime Contract Rule 9).
   */
  // eslint-disable-next-line @typescript-eslint/max-params
  private generateV2CasesFromArtificer(
    affectedTools: unknown,
    positiveCases: readonly GoldenTraceCase[],
    taskId: string,
    runId: string,
  ): readonly AdversarialCase[] {
    // Resolve toolName: prefer affectedTools[0], fall back to positive case.
    let toolName: string | null = null;
    if (Array.isArray(affectedTools) && affectedTools.length > 0) {
      const [first] = affectedTools;
      if (typeof first === 'string' && first.trim() !== '') {
        toolName = first;
      }
    }
    if (toolName === null && positiveCases.length > 0) {
      const [firstPos] = positiveCases;
      const posTool = firstPos?.toolName;
      if (typeof posTool === 'string' && posTool.trim() !== '') {
        toolName = posTool;
      }
    }
    if (toolName === null) {
      this.emitEvent('v2_adversarial_cases_skipped', taskId, {
        runId,
        reason: 'no_tool_name_for_v2_adversarial_cases',
        nextAction: 'verify_artificer_emitted_affectedTools_or_positive_case_toolName',
      });
      return [];
    }

    // Resolve targetPath: first positive case's params.path.
    const [firstPositive] = positiveCases;
    if (!firstPositive) {
      this.emitEvent('v2_adversarial_cases_skipped', taskId, {
        runId,
        reason: 'no_positive_case_for_v2_adversarial_cases',
        nextAction: 'verify_artificer_emitted_at_least_one_positive_case',
      });
      return [];
    }
    const pathParam = firstPositive.params?.path;
    if (typeof pathParam !== 'string' || pathParam.trim() === '') {
      this.emitEvent('v2_adversarial_cases_skipped', taskId, {
        runId,
        reason: 'no_path_param_for_v2_adversarial_cases',
        nextAction: 'verify_positive_case_has_string_path_param',
      });
      return [];
    }

    const canonicalKind = canonicalizeToolKind(toolName);
    // PRI-485 Phase 6: the 5 v2 templates are write-path semantics (alias /
    // path-boundary / combination all assume a write action). Generating them
    // for read/search/execute/agent/other tools would produce mismatched
    // negative cases (e.g. expected block on a read tool). Degrade with
    // telemetry (rc-9) and return [] — non-write tools fall back to the
    // LLM-supplied adversarial cases only.
    if (canonicalKind !== 'write') {
      this.emitEvent('v2_adversarial_cases_skipped', taskId, {
        runId,
        reason: 'non_write_canonical_kind_for_v2_adversarial_cases',
        nextAction: 'verify_artificer_target_tool_is_write_kind_or_supply_custom_adversarial_cases',
        toolName,
        canonicalKind,
      });
      return [];
    }
    return generateV2ContextAdversarialCases({
      toolName,
      targetPath: pathParam,
      canonicalKind,
    });
  }

  /**
   * Map sandbox failed cases to EvaluatorAdversarialResult.failedCases.
   *
   * The sandbox reports failedCases by caseId; we enrich each with the
   * adversarial case's attackType and expectedDecision. Cases not found in
   * the adversarial set (e.g. the merged positive case failed — which would
   * indicate a code bug, not an adversarial failure) are reported with
   * attackType='boundary' as a safe default and a note in the rationale
   * (Runtime Contract Rule 9: graceful degradation includes a reason).
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private mapFailedCases(
    gateResult: { readonly sandboxResult: { readonly failedCases: readonly { readonly caseId: string; readonly errorType: string; readonly message: string }[] } },
    adversarialCases: readonly { readonly caseId: string; readonly attackType: 'boundary' | 'omission' | 'inversion'; readonly expectedDecision: 'allow' | 'block' | 'propose_correction' }[],
  ): AdversarialFailedCase[] {
    const advById = new Map(adversarialCases.map((c) => [c.caseId, c]));
    return gateResult.sandboxResult.failedCases.map((fc) => {
      const adv = advById.get(fc.caseId);
      return {
        caseId: fc.caseId,
        attackType: adv?.attackType ?? 'boundary',
        actualDecision: fc.errorType,
        expectedDecision: adv?.expectedDecision ?? 'block',
        rationale: adv
          ? `${fc.errorType}: ${fc.message}`
          : `non-adversarial case ${fc.caseId} failed (${fc.errorType}: ${fc.message}) — likely a code defect, not an adversarial gap`,
      };
    });
  }

  // ── PRI-427: rule artifact assembly ────────────────────────────────────────

  /**
   * Assemble and persist the rule artifact when adversarial replay passed
   * (PRD Decision 5). The rule artifact carries implementationCode + the
   * Artificer full golden trace + ruleHostGateDecision, with artifactKind='rule'.
   * After a successful write, marks the artifact 'validated' so RuleHostWriter
   * can activate it.
   *
   * Returns the rule artifactId on success, null on any degradation (missing
   * code/trace, write failure, validation-update failure). Every null path
   * emits structured telemetry with a reason (Runtime Rule 9, ERR-018).
   */
  // eslint-disable-next-line @typescript-eslint/max-params
  private async assembleRuleArtifact(
    output: EvaluatorOutputV2,
    taskId: string,
    runId: string,
    context: EvaluatorContext,
    lineageArtifactIds: readonly string[],
  ): Promise<string | null> {
    if (!context.artificerArtifact) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: 'no_artificer_artifact_in_context',
        nextAction: 'verify_buildContext_resolves_artificer_artifact',
      });
      return null;
    }

    const artificerParsed = this.parseArtificerArtifact(context.artificerArtifact);
    if (!artificerParsed) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: 'artificer_artifact_unparseable',
        nextAction: 'verify_artificer_artifact_contentJson',
      });
      return null;
    }

    const { implementationCode, goldenTraceCases, affectedTools, requiresContextVersion, evidenceRefs } = artificerParsed;
    if (typeof implementationCode !== 'string' || implementationCode.trim() === '') {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: 'artificer_artifact_has_no_implementation_code',
        nextAction: 'verify_artificer_l2_adapter_emitted_v2',
      });
      return null;
    }

    // Runtime Rule 4: validate the array shape before passing to the builder.
    // buildGoldenTraceFromArtificer re-validates each element structurally, but
    // the type signature requires an array — narrow with Array.isArray first.
    if (!Array.isArray(goldenTraceCases)) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: 'artificer_golden_trace_cases_not_array',
        nextAction: 'verify_artificer_emitted_goldenTraceCases_array',
      });
      return null;
    }

    // Build the production golden trace from the Artificer cases. This is the
    // trace that gets ENFORCED at runtime — distinct from the adversarial
    // replay trace used to TEST the code in PRI-426. buildGoldenTraceFromArtificer
    // validates each case structurally (Runtime Rule 4) and requires ≥1 positive
    // + ≥1 negative case.
    const traceBuild = buildGoldenTraceFromArtificer({
      cases: goldenTraceCases,
      sourceArtifactId: context.sourceArtificerArtifactId ?? undefined,
    });
    if (!traceBuild.ok) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: `golden_trace_build_failed: ${traceBuild.reason}`,
        nextAction: 'verify_artificer_emitted_valid_positive_plus_negative_cases',
      });
      return null;
    }

    // affectedTools: optional array. Validate element types (Runtime Rule 4) —
    // do not trust the upstream shape. Default to [] when absent/malformed.
    const validatedAffectedTools = Array.isArray(affectedTools)
      ? affectedTools.filter((t): t is string => typeof t === 'string')
      : [];

    const ruleContent = {
      implementationCode,
      goldenTrace: traceBuild.trace,
      goldenTraceCases,
      affectedTools: validatedAffectedTools,
      // adversarialResult.passed === true is the precondition for this method;
      // the gate decision is therefore accepted_shadow.
      ruleHostGateDecision: 'accepted_shadow',
      sourceArtificerArtifactId: context.sourceArtificerArtifactId ?? output.sourceArtificerArtifactId,
      adversarialResult: output.adversarialResult,
      ...(requiresContextVersion === 2 ? { requiresContextVersion } : {}),
      // PRI-490: preserve evidenceRefs from Artificer artifact into rule artifact.
      // Only include when the array is valid (non-empty strings) — v1 rules may omit.
      ...(requiresContextVersion === 2 && Array.isArray(evidenceRefs) && evidenceRefs.every((e: unknown) => typeof e === 'string' && e.trim() !== '')
        ? { evidenceRefs: evidenceRefs as string[] }
        : {}),
    };

    // P1 #7 (cross-package acceptance test discovery): resolve the scribe
    // principle artifact and carry forward its principle ID as
    // sourcePrincipleId on the rule artifact. Without this, extractPrincipleId()
    // in the activation dispatcher returns null for rule artifacts, causing
    // activateArtifact() to fail with 'invalid_artifact'/'no_principle_id'.
    // The rule artifact must carry lineage to the principle it enforces.
    let resolvedSourcePrincipleId: string | undefined;
    try {
      const principleBearerId = await this.resolvePrincipleBearerArtifact(output, taskId);
      if (principleBearerId) {
        const principleArtifact = await this.artifactStore.getArtifactById(principleBearerId);
        if (principleArtifact) {
          resolvedSourcePrincipleId = EvaluatorRunner.extractPrincipleIdFromArtifact(principleArtifact);
        }
      }
    } catch (resolveErr) {
      // Fail this optional rule path explicitly below while preserving the
      // already-written principle artifact and prompt-channel fallback.
      this.emitEvent('rule_principle_id_resolve_failed', taskId, {
        runId,
        reason: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
        nextAction: 'verify_scribe_artifact_lineage',
      });
    }

    if (!resolvedSourcePrincipleId) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: 'sourcePrincipleId_unresolved',
        nextAction: 'verify_scribe_artifact_lineage_before_enqueuing_rule_approval',
      });
      return null;
    }

    const ruleArtifactId = `pi-rule-${taskId}-${runId}`;
    const ruleId = `rule-${taskId}`;
    const nowIso = new Date().toISOString();
    try {
      await this.artifactStore.upsertArtifact({
        artifactId: ruleArtifactId,
        artifactKind: 'rule',
        sourceTaskId: taskId,
        sourcePrincipleId: resolvedSourcePrincipleId,
        sourceRuleId: ruleId,
        lineageArtifactIds: [...lineageArtifactIds],
        validationStatus: 'pending',
        contentJson: JSON.stringify(ruleContent),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } catch (writeErr) {
      // PRD Decision 5 degradation: assembly write failure → principle artifact
      // already written, prompt channel usable. Do NOT crash the runner.
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: `artifact_write_failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        nextAction: 'prompt_channel_fallback_available',
      });
      return null;
    }

    // Mark the fully traceable rule validated so RuleHostWriter can activate it.
    try {
      const updated = await this.artifactStore.updateValidationStatus(ruleArtifactId, 'validated');
      if (!updated) {
        this.emitEvent('rule_assembly_failed', taskId, {
          runId,
          reason: 'updateValidationStatus_returned_false',
          ruleArtifactId,
          nextAction: 'verify_artifact_store_consistency',
        });
        return null;
      }
    } catch (updateErr) {
      this.emitEvent('rule_assembly_failed', taskId, {
        runId,
        reason: `updateValidationStatus_threw: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
        ruleArtifactId,
        nextAction: 'verify_artifact_store_consistency',
      });
      return null;
    }

    this.emitEvent('rule_assembled', taskId, {
      runId,
      artifactId: ruleArtifactId,
      affectedTools: validatedAffectedTools,
      traceCaseCount: traceBuild.trace.cases.length,
    });
    return ruleArtifactId;
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

    // Strategy 2b: Transitive lineage search. The evaluator's direct dependency
    // is the artificer task; the scribe task (which carries the principleDraft)
    // is a transitive dependency (evaluator → artificer → scribe). When direct
    // lineage has no principle-bearing artifact, traverse one level deeper by
    // resolving each direct-lineage artifact's source task and searching ITS
    // dependencies. This is bounded to depth 2 to prevent unbounded traversal.
    if (candidates.length === 0 && lineageArtifactIds.length > 0) {
      const transitiveCandidates = await this.resolveTransitivePrincipleCandidates(taskId, lineageArtifactIds);
      candidates.push(...transitiveCandidates);
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

  /**
   * Resolve principle-bearing artifacts from transitive lineage (depth 2).
   *
   * For each direct-lineage artifact, resolve its source task's dependencies
   * and search those artifacts for principle-kind artifacts with principleDraft
   * content. This handles the common case where the evaluator's direct
   * dependency is the artificer, and the scribe (principle-bearer) is a
   * transitive dependency (evaluator → artificer → scribe).
   *
   * Bounded to depth 2 to prevent unbounded traversal. Cycle-safe via the
   * visited set.
   */
  private async resolveTransitivePrincipleCandidates(
    evaluatorTaskId: string,
    directLineageArtifactIds: string[],
  ): Promise<string[]> {
    const candidates: string[] = [];
    const visited = new Set<string>([evaluatorTaskId]);

    for (const artifactId of directLineageArtifactIds) {
      if (visited.has(artifactId)) continue;
      visited.add(artifactId);

      const artifact = await this.artifactStore.getArtifactById(artifactId);
      if (!artifact) continue;

      // Resolve the source task's dependencies (one level deeper)
      const { ids: deeperLineageIds } = await this.resolveLineageArtifactIds(artifact.sourceTaskId);
      for (const deeperId of deeperLineageIds) {
        if (visited.has(deeperId)) continue;
        visited.add(deeperId);

        const deeperArtifact = await this.artifactStore.getArtifactById(deeperId);
        if (!deeperArtifact) continue;
        if (deeperArtifact.artifactKind !== 'principle') continue;
        if (this.hasPrincipleDraftContent(deeperArtifact.contentJson)) {
          candidates.push(deeperId);
        }
      }
    }

    return candidates;
  }
}
