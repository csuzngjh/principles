/**
 * runAdversarialLoop — synchronous Round 1→N Artificer↔Evaluator adversarial
 * loop (RuleHost MVP, PRI-428, PRD Decision 11 multi-round).
 *
 * This is a SEPARATE execution entry point from the lease-based
 * InternalizationOrchestrator (which is single-step + successor-proposal).
 * It wraps real ArtificerRunner + EvaluatorRunner instances and drives the
 * cross-runner retry loop synchronously, injecting prior adversarial
 * failures into Round-2+ Artificer prompts.
 *
 * Design constraints:
 *   - Does NOT modify InternalizationOrchestrator, BasePeerRunner, or the
 *     lease-based execution model.
 *   - Creates fresh task records per round (deterministic IDs) so the runners
 *     can lease + run them through their normal pipeline.
 *   - Every failure mode degrades to { decision: 'rejected' } with a
 *     structured degradationReason — the loop never throws (ERR-018).
 *   - PRD hard cap: maxRounds = 2.
 *
 * @see docs/plans/rulehost-mvp-activation.md Decision 11 multi-round pseudocode
 */
import type { ArtificerRunner } from './internalization/artificer-runner.js';
import type { EvaluatorRunner } from './internalization/evaluator-runner.js';
import type { RuntimeStateManager } from './store/runtime-state-manager.js';
import type { PIArtifactStore } from './internalization/pi-artifact.js';
import { isArtificerOutputV2 } from './internalization/artificer-output.js';
import { isEvaluatorOutputV2 } from './internalization/evaluator-output.js';
import type { EvaluatorAdversarialResult } from './internalization/evaluator-output.js';
import { formatAdversarialFeedback } from './internalization/adversarial-feedback.js';
/* eslint-disable @typescript-eslint/no-use-before-define -- helper functions declared after main, matching codebase convention */
import { createPITaskDiagnosticJson } from './internalization/pitask-metadata.js';

/** PRD hard cap on adversarial rounds. */
export const DEFAULT_MAX_ROUNDS = 2;

export interface AdversarialLoopInput {
  readonly artificerRunner: ArtificerRunner;
  readonly evaluatorRunner: EvaluatorRunner;
  readonly stateManager: RuntimeStateManager;
  /** Shared artifact store (the same one both runners were constructed with). */
  readonly artifactStore: PIArtifactStore;
  /** Succeeded scribe task the Round-1 Artificer depends on. */
  readonly scribeTaskId: string;
  /** Max rounds (PRD cap = 2). Defaults to DEFAULT_MAX_ROUNDS. */
  readonly maxRounds?: number;
  /** Correlation prefix for task IDs (default 'adversarial-loop'). */
  readonly correlationId?: string;
  /** Channel for created tasks (default 'prompt'). */
  readonly channel?: 'prompt' | 'code_tool_hook' | 'defer_archive';
}

export interface AdversarialLoopResult {
  /** Final outcome. 'approved' = rule artifact written; 'rejected' = degraded. */
  readonly decision: 'approved' | 'rejected';
  /** Number of rounds actually executed (1..maxRounds). */
  readonly rounds: number;
  /** The final evaluator task's ID (for lineage/telemetry lookup). */
  readonly finalEvaluatorTaskId: string;
  /** Rule artifact ID when approved; null otherwise. */
  readonly ruleArtifactId: string | null;
  /** Principle artifact ID (always present on the final evaluator task). */
  readonly principleArtifactId: string | null;
  /** Adversarial result from the final round, when V2 path ran. */
  readonly adversarialResult?: EvaluatorAdversarialResult;
  /** Structured reason when decision === 'rejected'. */
  readonly degradationReason?: string;
}

/**
 * Run the multi-round adversarial loop. Never throws — all failure modes
 * return { decision: 'rejected', degradationReason }.
 */
export async function runAdversarialLoop(input: AdversarialLoopInput): Promise<AdversarialLoopResult> {
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const correlation = input.correlationId ?? 'adversarial-loop';
  const channel = input.channel ?? 'prompt';

  let adversarialFeedback: string | undefined = undefined;
  let lastEvaluatorTaskId = '';
  let lastPrincipleArtifactId: string | null = null;
  let lastAdversarialResult: EvaluatorAdversarialResult | undefined;

  for (let round = 1; round <= maxRounds; round += 1) {
    // ── Round N: Artificer ──
    const artificerTaskId = `${correlation}-artificer-r${round}-${Date.now().toString(36)}`;
    try {
      await input.stateManager.createTask({
        taskId: artificerTaskId,
        taskKind: 'artificer',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        diagnosticJson: createPITaskDiagnosticJson({
          dependencyTaskIds: [input.scribeTaskId],
          channel,
          timeoutMs: 300_000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
          adversarialFeedback,
        }),
      });
    } catch (createErr) {
      return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `artificer_task_create_failed: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
    }

    let artificerResult;
    try {
      artificerResult = await input.artificerRunner.run(artificerTaskId);
    } catch (runErr) {
      return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `artificer_run_threw: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
    }

    if (artificerResult.status !== 'succeeded' || !artificerResult.output) {
      return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `artificer_run_status_${artificerResult.status ?? 'unknown'}`);
    }

    const artificerOutput = artificerResult.output;
    const artificerArtifactId = artificerResult.artifactId ?? null;

    // ── V1 degradation: Artificer L2 fell back to plan-only (no code) ──
    // Per PRD: skip code review, run evaluator on the V1 plan, degrade.
    if (!isArtificerOutputV2(artificerOutput)) {
      const v1EvaluatorTaskId = `${correlation}-evaluator-r${round}-${Date.now().toString(36)}`;
      await createEvaluatorTask(input.stateManager, v1EvaluatorTaskId, artificerTaskId, channel);
      try {
        await input.evaluatorRunner.run(v1EvaluatorTaskId);
      } catch {
        // Non-fatal: we're degrading anyway. Principle artifact may still be written.
      }
      const v1Principle = await resolvePrincipleArtifactId(input, v1EvaluatorTaskId);
      return {
        decision: 'rejected',
        rounds: round,
        finalEvaluatorTaskId: v1EvaluatorTaskId,
        ruleArtifactId: null,
        principleArtifactId: v1Principle,
        degradationReason: 'artificer_degraded_to_v1_no_implementation_code',
      };
    }

    // ── Round N: Evaluator (V2 code-review + adversarial replay) ──
    const evaluatorTaskId = `${correlation}-evaluator-r${round}-${Date.now().toString(36)}`;
    lastEvaluatorTaskId = evaluatorTaskId;
    try {
      await createEvaluatorTask(input.stateManager, evaluatorTaskId, artificerTaskId, channel);
    } catch (createErr) {
      return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `evaluator_task_create_failed: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
    }

    let evaluatorResult;
    try {
      evaluatorResult = await input.evaluatorRunner.run(evaluatorTaskId);
    } catch (runErr) {
      return rejected(round, evaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `evaluator_run_threw: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
    }

    if (evaluatorResult.status !== 'succeeded' || !evaluatorResult.output) {
      return rejected(round, evaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `evaluator_run_status_${evaluatorResult.status ?? 'unknown'}`);
    }

    const evaluatorOutput = evaluatorResult.output;
    const { decision } = evaluatorOutput.evaluation;
    lastPrincipleArtifactId = evaluatorResult.artifactId ?? await resolvePrincipleArtifactId(input, evaluatorTaskId);
    if (isEvaluatorOutputV2(evaluatorOutput) && evaluatorOutput.adversarialResult) {
      lastAdversarialResult = evaluatorOutput.adversarialResult;
    }

    if (decision === 'approved') {
      // Rule artifact written by EvaluatorRunner.succeedTask (PRI-427) when
      // adversarialResult.passed === true. Resolve it from the store.
      const ruleArtifactId = await resolveRuleArtifactId(input, evaluatorTaskId);
      return {
        decision: 'approved',
        rounds: round,
        finalEvaluatorTaskId: evaluatorTaskId,
        ruleArtifactId,
        principleArtifactId: lastPrincipleArtifactId,
        adversarialResult: lastAdversarialResult,
      };
    }

    if (decision === 'rejected') {
      return {
        decision: 'rejected',
        rounds: round,
        finalEvaluatorTaskId: evaluatorTaskId,
        ruleArtifactId: null,
        principleArtifactId: lastPrincipleArtifactId,
        adversarialResult: lastAdversarialResult,
        degradationReason: 'evaluator_rejected',
      };
    }

    // needs_revision: prepare feedback for the next round.
    const failedCases = isEvaluatorOutputV2(evaluatorOutput) && evaluatorOutput.adversarialResult
      ? evaluatorOutput.adversarialResult.failedCases
      : [];
    adversarialFeedback = formatAdversarialFeedback(failedCases);
    // Loop continues to next round.
    void artificerArtifactId;
  }

  // ── Round (maxRounds + 1): exhausted, degrade ──
  return {
    decision: 'rejected',
    rounds: maxRounds,
    finalEvaluatorTaskId: lastEvaluatorTaskId,
    ruleArtifactId: null,
    principleArtifactId: lastPrincipleArtifactId,
    adversarialResult: lastAdversarialResult,
    degradationReason: `max_rounds_exhausted_after_${maxRounds}`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/max-params
async function createEvaluatorTask(
  stateManager: RuntimeStateManager,
  evaluatorTaskId: string,
  artificerTaskId: string,
  channel: 'prompt' | 'code_tool_hook' | 'defer_archive',
): Promise<void> {
  await stateManager.createTask({
    taskId: evaluatorTaskId,
    taskKind: 'evaluator',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [artificerTaskId],
      channel,
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  });
}

async function resolvePrincipleArtifactId(
  input: AdversarialLoopInput,
  evaluatorTaskId: string,
): Promise<string | null> {
  try {
    const artifacts = await input.artifactStore.listBySourceTaskId(evaluatorTaskId);
    const principle = artifacts.find((a) => a.artifactKind === 'principle');
    return principle?.artifactId ?? null;
  } catch {
    return null;
  }
}

async function resolveRuleArtifactId(
  input: AdversarialLoopInput,
  evaluatorTaskId: string,
): Promise<string | null> {
  try {
    const artifacts = await input.artifactStore.listBySourceTaskId(evaluatorTaskId);
    const rule = artifacts.find((a) => a.artifactKind === 'rule');
    return rule?.artifactId ?? null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/max-params
function rejected(
  rounds: number,
  finalEvaluatorTaskId: string,
  principleArtifactId: string | null,
  adversarialResult: EvaluatorAdversarialResult | undefined,
  reason: string,
): AdversarialLoopResult {
  return {
    decision: 'rejected',
    rounds,
    finalEvaluatorTaskId,
    ruleArtifactId: null,
    principleArtifactId,
    adversarialResult,
    degradationReason: reason,
  };
}
