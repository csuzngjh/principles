/**
 * DreamerRunner — First real peer runner for the Internalization Engine (PRI-67).
 *
 * Migrated to extend BasePeerRunner (PRI-302). The shared lease → buildContext →
 * invoke → poll → fetch → validate → succeed/fail pipeline is now in the base
 * class. This file only contains Dreamer-specific logic.
 *
 * Key constraints (ADR-0003):
 *   - Uses PDRuntimeAdapter for all LLM execution (no direct SDK calls)
 *   - Does NOT directly invoke Philosopher/Scribe (host layer enqueues next task)
 *   - No plugin-layer imports (core is infrastructure-agnostic)
 *   - Uses RuntimeStateManager for all state operations
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 * @see BasePeerRunner in runner/base-peer-runner.ts
 */
import type { RunHandle } from '../runtime-protocol.js';
import type { DreamerOutput, DreamerValidator } from './dreamer-output.js';
import type { TaskRecord } from '../task-status.js';
import type { OutputLanguage } from '../language-directive.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import { hydratePITaskRecord, parseSeedSourcePainId } from './pitask-metadata.js';
import { DreamerPromptBuilder } from './dreamer-prompt-builder.js';
import { reconcileLineageEcho } from './peer-runner-contracts.js';
import { stripFabricatedCorePrincipleIds } from '../core-principles/index.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import type {
  PeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../runner/peer-runner-types.js';

// ── Dreamer-specific context ─────────────────────────────────────────────────

/** Context built by DreamerRunner.buildContext() and consumed by invokeRuntime(). */
interface DreamerContext {
  readonly contextHash: string;
  readonly contextRefs: string[];
  readonly predecessorOutput: unknown;
  /**
   * PRI-862: canonical pain id from the dreamer task seed
   * (diagnostic_json.sourcePainId, written by the intake bridge).
   * The only authority the runner accepts for sourcePainId — null means
   * no provenance is available, and an LLM-supplied value must be dropped.
   */
  readonly seedSourcePainId: string | null;
}

// ── Result Types (backward-compatible exports) ───────────────────────────────

export type DreamerRunnerResultStatus = 'succeeded' | 'failed' | 'retried';

export interface DreamerRunnerResult {
  readonly status: DreamerRunnerResultStatus;
  readonly taskId: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly resultRef?: string;
  readonly contextHash?: string;
  readonly output?: DreamerOutput;
  readonly errorCategory?: PDErrorCategory;
  readonly failureReason?: string;
  readonly attemptCount: number;
}

// ── Constructor Options (backward-compatible exports) ────────────────────────

export type DreamerRunnerOptions = PeerRunnerOptions;

export interface ResolvedDreamerRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
  /**
   * Owner's preferred language for candidate fields (PRI-336/PRI-714).
   * Forwarded to DreamerPromptBuilder so badDecision/betterDecision/rationale
   * follow the owner's language. Undefined = no directive (backward compatible).
   */
  readonly outputLanguage?: OutputLanguage;
  /** Whether to inject CORE_PRINCIPLES into the dreamer prompt (default: true). */
  readonly coreGrounding: boolean;
}

export const DEFAULT_DREAMER_RUNNER_OPTIONS: Readonly<Omit<ResolvedDreamerRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'dreamer',
  coreGrounding: true,
} as const;

export function resolveDreamerRunnerOptions(options: DreamerRunnerOptions): ResolvedDreamerRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_DREAMER_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_DREAMER_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_DREAMER_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    outputLanguage: options.outputLanguage,
    agentId: options.agentId ?? DEFAULT_DREAMER_RUNNER_OPTIONS.agentId,
    coreGrounding: options.coreGrounding ?? DEFAULT_DREAMER_RUNNER_OPTIONS.coreGrounding,
  };
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface DreamerRunnerDeps extends PeerRunnerDeps {
  readonly validator: DreamerValidator;
}

// ── DreamerRunner ────────────────────────────────────────────────────────────

export class DreamerRunner extends BasePeerRunner<DreamerContext, DreamerOutput> {
  private readonly validator: DreamerValidator;

  constructor(deps: DreamerRunnerDeps, options: PeerRunnerOptions) {
    super(deps, options, {
      runnerName: 'dreamer',
      expectedTaskKind: 'dreamer',
      defaultAgentId: 'dreamer',
      resultRefPrefix: 'dreamer',
    });
    this.validator = deps.validator;
  }

  // ── Abstract implementations ───────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid']);
  }

  async buildContext(taskId: string): Promise<DreamerContext> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    const contextRefs: string[] = [];
    const rejectedDeps: string[] = [];
    let predecessorOutput: unknown = null;

    if (deps.length > 0) {
      const results = await Promise.allSettled(
        deps.map((depId) => this.stateManager.getTask(depId)),
      );
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const depId = deps[i];
        if (!result || depId === undefined) continue;
        if (result.status === 'rejected') {
          rejectedDeps.push(depId);
        } else if (result.status === 'fulfilled' && result.value) {
          if (result.value.resultRef) {
            contextRefs.push(result.value.resultRef);
          }
          const depPiTask = result.value ? hydratePITaskRecord(result.value) : null;
          if (depPiTask?.outputArtifactRefs) {
            contextRefs.push(...depPiTask.outputArtifactRefs.map((a) => a.ref));
          }
          if (result.value.status === 'succeeded' && predecessorOutput === null) {
            const artifacts = await this.artifactStore.listBySourceTaskId(depId);
            const [first] = artifacts;
            if (artifacts.length > 0 && first) {
              let parsedContent: unknown;
              try {
                parsedContent = JSON.parse(first.contentJson);
              } catch {
                parsedContent = first.contentJson;
              }
              predecessorOutput = parsedContent;
            }
          }
        }
      }
    }

    if (rejectedDeps.length > 0) {
      this.emitEvent('context_partial', taskId, {
        rejectedCount: rejectedDeps.length,
        rejectedDeps,
      });
    }

    const contextHash = BasePeerRunner.hashContextRefs(contextRefs);
    return {
      contextHash,
      contextRefs,
      predecessorOutput,
      seedSourcePainId: parseSeedSourcePainId(task.diagnosticJson),
    };
  }

  async invokeRuntime(taskId: string, context: DreamerContext): Promise<RunHandle> {
    const {coreGrounding, outputLanguage} = this.resolvedOptions;
    const builder = new DreamerPromptBuilder({ coreGrounding, outputLanguage });
    const { message, systemPrompt } = builder.buildPrompt({
      taskId,
      contextHash: context.contextHash,
      contextRefs: context.contextRefs,
      predecessorOutput: context.predecessorOutput,
      coreGrounding,
      outputLanguage,
    });

    return this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'dreamer-output-v1',
      timeoutMs: this.resolvedOptions.timeoutMs,
      systemPrompt,
    });
  }

  async validateOutput(output: unknown, taskId: string): Promise<PeerRunnerValidationResult> {
    const result = await this.validator.validate(output, taskId);
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
    output: DreamerOutput,
    task: TaskRecord,
    contextHash: string,
    _context: DreamerContext,
  ): Promise<PeerRunnerResult<DreamerOutput>> {
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

    // Write PIArtifact via artifactStore (idempotent upsert)
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
    // PRI-911A (I1+I3 writer boundary): the identity column is reserved for
    // canonical ledger UUIDs. An LLM-asserted `sourcePrincipleId` is an
    // UNTRUSTED CLAIM — postFetchTransform's stripFabricatedCorePrincipleIds
    // already removed everything except a Historical Core Principle id
    // (`T-NN`), and those are registry entries, not ledger principles. So no
    // assertion this runner can see is ever a canonical identity, and none is
    // carried. The value still rides in contentJson, which is where the display
    // resolver reads it from — Bug-O L1's 'unlinked' symptom is unaffected.
    // Stamping the real identity is ScribeRunner's job (PR #1856 I2), which
    // resolves it against the ledger instead of asserting it.
    const assertedPrincipleId = output.sourcePrincipleId;
    if (typeof assertedPrincipleId === 'string' && assertedPrincipleId.trim() !== '') {
      this.emitEvent('identity_assertion_not_carried', taskId, {
        runId,
        reason: 'non_canonical_identity',
        assertedPrincipleId,
        nextAction: 'identity_is_stamped_from_the_ledger_by_the_chain_not_asserted',
      });
    }
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
      candidateCount: output.candidates.length,
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
   * taskId: re-inject if stripped by stripLineageFields (PRI-272 / ERR-008).
   * Only fill when absent via Object.hasOwn — present-but-falsy taskId
   * must reach validation and fail loud (Runtime Contract Rule 3).
   *
   * PRI-862 (CIL-006): sourcePainId follows the same echo gate but with
   * the task seed as authority — a seeded value overrides any LLM echo
   * (fabrication arm), and when NO seed exists the LLM value is dropped
   * (loss-of-trust arm: provenance degrades to null observably, the model
   * string is never trusted). This holds on every runtime adapter,
   * including the paths that do not strip lineage fields themselves.
   * The correction event carries `seedPresent` so the two arms stay
   * separately measurable (rc-9 structured reason).
   *
   * Also strips fabricated sourcePrincipleId values via the shared
   * stripFabricatedCorePrincipleIds utility. The generatedAt override is
   * handled by the base class via super.postFetchTransform().
   */
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown, context: DreamerContext): void {
    super.postFetchTransform(taskId, untrustedOutput, context);
    // Shared lineage echo gate (PRI-541). Emits telemetry on correction so
    // the LLM echo-corruption rate stays observable (rc-9).
    const seed = context.seedSourcePainId;
    const correctedFields = reconcileLineageEcho(untrustedOutput, {
      topFields: [
        { field: 'taskId', authoritativeValue: taskId },
        ...(seed !== null ? [{ field: 'sourcePainId', authoritativeValue: seed }] : []),
      ],
    });
    if (seed === null
      && untrustedOutput !== null && typeof untrustedOutput === 'object' && !Array.isArray(untrustedOutput)
      && Object.hasOwn(untrustedOutput, 'sourcePainId')) {
      // rc-5: hasOwn, not in. The LLM invented lineage with no canonical
      // backing — drop it so formation-context provenance reads null
      // (legitimate degraded state) instead of a fabricated id.
      Reflect.deleteProperty(untrustedOutput, 'sourcePainId');
      correctedFields.push('sourcePainId');
    }
    if (correctedFields.length > 0) {
      // seedPresent is the arm discriminator: true ⇒ fabricated echo was
      // overridden by the canonical seed; false ⇒ unbacked model string was
      // dropped. Without it the two arms collapse into one unmeasurable rate.
      this.emitEvent('lineage_echo_corrected', taskId, { correctedFields, seedPresent: seed !== null });
    }
    stripFabricatedCorePrincipleIds(untrustedOutput);
  }

  protected override emitSuccessTelemetry(taskId: string, output: DreamerOutput): void {
    for (const candidate of output.candidates) {
      this.emitEvent('candidate_generated', taskId, {
        candidateIndex: candidate.candidateIndex,
        confidence: candidate.confidence,
        riskLevel: candidate.riskLevel,
      });
    }
  }
}
