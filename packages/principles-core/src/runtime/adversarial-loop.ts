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
import { isEvaluatorOutputV2 } from './internalization/evaluator-output.js';
import type { EvaluatorAdversarialResult } from './internalization/evaluator-output.js';
import { formatAdversarialFeedback } from './internalization/adversarial-feedback.js';
/* eslint-disable @typescript-eslint/no-use-before-define -- helper functions declared after main, matching codebase convention */
import type { createPITaskDiagnosticJson } from './internalization/pitask-metadata.js';
import { hydratePITaskRecord } from './internalization/pitask-metadata.js';
import { createLogicalSuccessorTask } from './internalization/successor-create.js';
import type { TaskRecord } from './task-status.js';
import type { PITaskRecord } from './internalization/peer-runner-contracts.js';
import type { PeerRunnerResult } from './runner/peer-runner-types.js';
import type { SucceededRunnerRecovery } from './runner/succeeded-result-recovery.js';
import type { CommitNextTaskResult } from './internalization/internalization-orchestrator.js';
import { decideInternalizationTransition, transitionInputFromTask } from './internalization/internalization-transition-decision.js';

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
  /**
   * Formal completion-transition authority. Production hosts must inject
   * InternalizationOrchestrator.commitNextTaskProposal. Repair completion and
   * upstream-revision cascades both go through this single authority; the loop
   * deliberately has no fallback that creates a parallel evaluator chain.
   */
  readonly commitTaskTransition?: (taskId: string) => Promise<CommitNextTaskResult>;
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

type LoopSuccessorPlan =
  | { readonly action: 'execute'; readonly task: TaskRecord; readonly creationOutcome: 'created' | 'existing' }
  | { readonly action: 'recover'; readonly task: TaskRecord; readonly creationOutcome: 'existing' }
  | { readonly action: 'blocked'; readonly reason: string; readonly task?: TaskRecord };

interface RecoverableRunner<TOutput> {
  run(taskId: string): Promise<PeerRunnerResult<TOutput>>;
  recoverSucceededResult(task: TaskRecord): Promise<SucceededRunnerRecovery<TOutput>>;
}

type PlannedRunnerOutcome<TOutput> =
  | { readonly kind: 'result'; readonly result: PeerRunnerResult<TOutput> }
  | { readonly kind: 'blocked'; readonly reason: string };

async function recoverOrRunTask<TOutput>(input: {
  readonly runner: RecoverableRunner<TOutput>;
  readonly task: TaskRecord;
  readonly stage: 'artificer' | 'evaluator';
  readonly getTask: (taskId: string) => Promise<TaskRecord | null>;
}): Promise<PlannedRunnerOutcome<TOutput>> {
  const { runner, task, stage, getTask } = input;
  if (task.status === 'succeeded') {
    const recovery = await runner.recoverSucceededResult(task);
    return recovery.outcome === 'recovered'
      ? { kind: 'result', result: recovery.result }
      : { kind: 'blocked', reason: `${stage}_recovery_invalid:${recovery.reason}` };
  }
  if (task.status === 'pending' || task.status === 'retry_wait') {
    const result = await runner.run(task.taskId);
    if (result.status !== 'failed' || result.errorCategory !== 'lease_conflict') {
      return { kind: 'result', result };
    }
    // State may have changed between successor lookup and lease acquisition.
    // Lease remains authoritative: re-read once, recover a completed result,
    // and never preempt an active lease or execute a terminal task again.
    const current = await getTask(task.taskId);
    if (!current) return { kind: 'blocked', reason: `${stage}_task_disappeared_after_lease_conflict` };
    if (current.status === 'succeeded') {
      const recovery = await runner.recoverSucceededResult(current);
      return recovery.outcome === 'recovered'
        ? { kind: 'result', result: recovery.result }
        : { kind: 'blocked', reason: `${stage}_recovery_invalid_after_lease_conflict:${recovery.reason}` };
    }
    if (current.status === 'leased') {
      return { kind: 'blocked', reason: `${stage}_successor_leased_active` };
    }
    return { kind: 'blocked', reason: `${stage}_successor_state_changed:${current.status}` };
  }
  if (task.status === 'leased') return { kind: 'blocked', reason: `${stage}_successor_leased_active` };
  if (task.status === 'failed') return { kind: 'blocked', reason: `${stage}_successor_failed_terminal` };
  if (task.status === 'needs_human_review') return { kind: 'blocked', reason: `${stage}_successor_needs_human_review` };
  return { kind: 'blocked', reason: `${stage}_successor_unknown_status:${task.status}` };
}

async function runPlannedSuccessor<TOutput>(input: {
  readonly plan: LoopSuccessorPlan;
  readonly runner: RecoverableRunner<TOutput>;
  readonly stage: 'artificer' | 'evaluator';
  readonly getTask: (taskId: string) => Promise<TaskRecord | null>;
}): Promise<PlannedRunnerOutcome<TOutput>> {
  if (input.plan.action === 'blocked') return { kind: 'blocked', reason: input.plan.reason };
  return recoverOrRunTask({
    runner: input.runner,
    task: input.plan.task,
    stage: input.stage,
    getTask: input.getTask,
  });
}

/**
 * Run the multi-round adversarial loop. Never throws — all failure modes
 * return { decision: 'rejected', degradationReason }.
 */
export async function runAdversarialLoop(input: AdversarialLoopInput): Promise<AdversarialLoopResult> {
  const requestedRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxRounds = Number.isFinite(requestedRounds)
    ? Math.max(1, Math.min(DEFAULT_MAX_ROUNDS, Math.floor(requestedRounds)))
    : DEFAULT_MAX_ROUNDS;
  const correlation = input.correlationId ?? 'adversarial-loop';
  const channel = input.channel ?? 'prompt';

  let adversarialFeedback: string | undefined = undefined;
  let lastEvaluatorTaskId = '';
  let lastPrincipleArtifactId: string | null = null;
  let lastAdversarialResult: EvaluatorAdversarialResult | undefined;

  for (let round = 1; round <= maxRounds; round += 1) {
    // ── Round N: Artificer ──
    const artificerTaskId = `${correlation}-artificer-r${round}-${Date.now().toString(36)}`;
    // PRI-1293 review fix: persist the REAL causal parent so the parentTaskId
    // lineage stays walkable end-to-end (the repair seeder's lineage gate
    // fails closed on dependency-only chains). Round 1 is caused by the
    // scribe; round N>1 exists because round N-1's evaluator demanded
    // revision — mirroring the lease-based repair flow whose repair artificer
    // is parented on the source evaluator.
    const artificerParentTaskId = round === 1 ? input.scribeTaskId : lastEvaluatorTaskId;
    let artificerPlan: LoopSuccessorPlan;
    try {
      artificerPlan = await createLoopSuccessorTask(input.stateManager, {
        preferredTaskId: artificerTaskId,
        taskKind: 'artificer',
        parentTaskId: artificerParentTaskId,
        channel,
        metadata: {
          dependencyTaskIds: [input.scribeTaskId],
          channel,
          timeoutMs: 300_000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
          adversarialFeedback,
          parentTaskId: artificerParentTaskId,
        },
      });
    } catch (createErr) {
      return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `artificer_task_create_failed: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
    }
    const resolvedArtificerTaskId = artificerPlan.action === 'blocked' ? artificerTaskId : artificerPlan.task.taskId;

    let artificerResult;
    try {
      const planned = await runPlannedSuccessor({
        plan: artificerPlan,
        runner: input.artificerRunner,
        stage: 'artificer',
        getTask: (taskId) => input.stateManager.getTask(taskId),
      });
      if (planned.kind === 'blocked') {
        return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
          planned.reason);
      }
      artificerResult = planned.result;
    } catch (runErr) {
      return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `artificer_run_threw: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
    }

    if (artificerResult.status !== 'succeeded' || !artificerResult.output) {
      return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `artificer_run_status_${artificerResult.status ?? 'unknown'}`);
    }

    const artificerArtifactId = artificerResult.artifactId ?? null;

    // ── Round N: Evaluator (code-review + adversarial replay) ──
    // The unified ArtificerRuleOutput always carries implementationCode (PRI-439).
    // If Artificer failed to produce valid code, ArtificerRunner.startRun throws
    // PDRuntimeError and artificerResult.status !== 'succeeded' is caught above.
    // There is no V1 plan-only degradation path.
    let resolvedEvaluatorTaskId = '';
    let evaluatorResult;
    try {
      const artificerTask = await input.stateManager.getTask(resolvedArtificerTaskId);
      const artificerPi = artificerTask ? hydratePITaskRecord(artificerTask) : null;
      if (!artificerTask || !artificerPi) {
        return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
          'artificer_successor_metadata_malformed');
      }

      if (artificerPi.repairPayload) {
        // Formal repair completion has exactly one transition authority. A
        // synchronous loop may drive the reopened evaluator, but must never
        // materialize a parallel evaluator successor chain.
        if (!input.commitTaskTransition) {
          return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            'repair_transition_authority_missing');
        }
        const commit = await input.commitTaskTransition(resolvedArtificerTaskId);
        if (commit.decision !== 'revision_reopened' && commit.decision !== 'revision_reopen_noop') {
          const reasonValue: unknown = Reflect.get(commit, 'reason');
          const detail = typeof reasonValue === 'string' && reasonValue !== '' ? `:${reasonValue}` : '';
          return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            `repair_transition_${commit.decision}${detail}`);
        }
        // A successful-looking commit must still be bound to the exact repair
        // task and source evaluator carried by the repair lineage. Otherwise a
        // malformed injected authority could redirect this loop onto another
        // chain while appearing to satisfy the two accepted decision values.
        if (commit.sourceTaskId !== resolvedArtificerTaskId) {
          return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            'repair_transition_source_task_mismatch');
        }
        if (commit.reopenedTaskId !== artificerPi.repairPayload.sourceEvaluatorTaskId) {
          return rejected(round, lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            'repair_transition_reopened_task_mismatch');
        }
        resolvedEvaluatorTaskId = commit.reopenedTaskId;
        const evaluatorTask = await input.stateManager.getTask(resolvedEvaluatorTaskId);
        const evaluatorPi = evaluatorTask ? hydratePITaskRecord(evaluatorTask) : null;
        if (!evaluatorTask || !evaluatorPi) {
          return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            'repair_reopened_evaluator_metadata_malformed');
        }
        if (!evaluatorPi.dependencyTaskIds.includes(resolvedArtificerTaskId)) {
          return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            'repair_transition_not_materialized_for_current_repair');
        }
        const repairRound = await enforceEvaluatorRevisionRound({
          stateManager: input.stateManager,
          evaluatorPi,
          currentRound: round,
          maxRounds,
          willExecute: evaluatorTask.status === 'pending' || evaluatorTask.status === 'retry_wait',
        });
        if (repairRound.kind === 'invalid') {
          return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            repairRound.reason);
        }
        const { round: enforcedRepairRound } = repairRound;
        round = enforcedRepairRound;
        lastEvaluatorTaskId = resolvedEvaluatorTaskId;
        const planned = await recoverOrRunTask({
          runner: input.evaluatorRunner,
          task: evaluatorTask,
          stage: 'evaluator',
          getTask: (taskId) => input.stateManager.getTask(taskId),
        });
        if (planned.kind === 'blocked') {
          return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            planned.reason);
        }
        evaluatorResult = planned.result;
      } else {
        // ── Round N: Evaluator (code-review + adversarial replay) ──
        // Ordinary adversarial feedback rounds still use a same-round evaluator
        // successor. The formal repair branch above is the only exception.
        const evaluatorTaskId = `${correlation}-evaluator-r${round}-${Date.now().toString(36)}`;
        let evaluatorPlan = await createEvaluatorTask(input.stateManager, evaluatorTaskId, resolvedArtificerTaskId, channel);
        // A terminal evaluator may belong to an older upstream artifact epoch.
        // When the ordinary artificer itself was reopened and completed a new
        // revision, the formal completion transition owns the cascade reopen;
        // recovery before that transition would reuse a stale verdict.
        const cascadeCandidate = evaluatorPlan.action === 'recover'
          || (evaluatorPlan.action === 'blocked' && evaluatorPlan.task?.status === 'needs_human_review');
        if (cascadeCandidate && (artificerPi.revisionCount ?? 0) > 0) {
          const successorBeforeCascade = evaluatorPlan.task;
          if (!successorBeforeCascade) {
            return rejected(round, evaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
              'evaluator_cascade_successor_snapshot_missing');
          }
          // A successor first created after the upstream revision already
          // evaluates the current artifact even though no cascade cause was
          // consumed. Recovery validation is input-current; use it as the
          // reuse proof and reserve formal reopen for stale/invalid evidence.
          let currentEvidenceReusable = false;
          if (evaluatorPlan.action === 'recover') {
            const recoveryProbe = await input.evaluatorRunner.recoverSucceededResult(successorBeforeCascade);
            currentEvidenceReusable = recoveryProbe.outcome === 'recovered';
          }
          if (!currentEvidenceReusable) {
            evaluatorPlan = await applyFormalSuccessorCascade({
              stateManager: input.stateManager,
              commitTaskTransition: input.commitTaskTransition,
              sourceTaskId: resolvedArtificerTaskId,
              successorTask: successorBeforeCascade,
            });
          }
        }
        if (evaluatorPlan.action === 'blocked') {
          return rejected(round, evaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            evaluatorPlan.reason);
        }
        resolvedEvaluatorTaskId = evaluatorPlan.task.taskId;
        const evaluatorPi = hydratePITaskRecord(evaluatorPlan.task);
        if (!evaluatorPi) {
          return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            'evaluator_successor_metadata_malformed');
        }
        const revisionRound = await enforceEvaluatorRevisionRound({
          stateManager: input.stateManager,
          evaluatorPi,
          currentRound: round,
          maxRounds,
          willExecute: evaluatorPlan.action === 'execute',
        });
        if (revisionRound.kind === 'invalid') {
          return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            revisionRound.reason);
        }
        const { round: enforcedRevisionRound } = revisionRound;
        round = enforcedRevisionRound;
        lastEvaluatorTaskId = resolvedEvaluatorTaskId;
        const planned = await runPlannedSuccessor({
          plan: evaluatorPlan,
          runner: input.evaluatorRunner,
          stage: 'evaluator',
          getTask: (taskId) => input.stateManager.getTask(taskId),
        });
        if (planned.kind === 'blocked') {
          return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
            planned.reason);
        }
        evaluatorResult = planned.result;
      }
    } catch (runErr) {
      return rejected(round, resolvedEvaluatorTaskId || lastEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `evaluator_run_threw: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
    }

    if (!evaluatorResult || evaluatorResult.status !== 'succeeded' || !evaluatorResult.output) {
      return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `evaluator_run_status_${evaluatorResult?.status ?? 'unknown'}`);
    }

    // Evaluator decision effects can deliberately route the task to Owner
    // attention while still returning the evaluated output (for example repair
    // seeding exhausted/failed). The synchronous loop must honor that durable
    // terminal state instead of using the output as permission to continue.
    const durableEvaluatorTask = await input.stateManager.getTask(resolvedEvaluatorTaskId);
    if (durableEvaluatorTask?.status === 'needs_human_review') {
      return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        'evaluator_needs_human_review');
    }
    if (durableEvaluatorTask?.status !== 'succeeded') {
      return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `evaluator_durable_status_${durableEvaluatorTask?.status ?? 'missing'}`);
    }

    const evaluatorOutput = evaluatorResult.output;
    lastPrincipleArtifactId = evaluatorResult.artifactId ?? await resolvePrincipleArtifactId(input, resolvedEvaluatorTaskId);
    if (isEvaluatorOutputV2(evaluatorOutput) && evaluatorOutput.adversarialResult) {
      lastAdversarialResult = evaluatorOutput.adversarialResult;
    }

    // The evaluator artifact preserves the RAW semantic verdict, while the
    // formal transition decision owns replay-failure and owner-provenance
    // overrides. Use that same authority here; duplicating only the replay
    // branch leaves owner-stamp repair seeded but unreachable.
    const durableEvaluatorPi = hydratePITaskRecord(durableEvaluatorTask);
    if (!durableEvaluatorPi) {
      return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        'evaluator_successor_metadata_malformed');
    }
    const replayFailed = isEvaluatorOutputV2(evaluatorOutput)
      && evaluatorOutput.adversarialResult !== undefined
      && evaluatorOutput.adversarialResult.passed !== true;
    const transition = decideInternalizationTransition(transitionInputFromTask(
      durableEvaluatorPi,
      evaluatorOutput.evaluation.decision,
      { adversarialReplayFailed: replayFailed },
    ));
    let decision: 'approved' | 'needs_revision' | 'rejected';
    if (transition.kind === 'ADVANCE') decision = 'approved';
    else if (transition.kind === 'REVISION_REQUIRED') decision = 'needs_revision';
    else if (transition.kind === 'TERMINAL_REJECT') decision = 'rejected';
    else {
      return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
        `evaluator_transition_${transition.kind}:${transition.reason}`);
    }

    if (decision === 'approved') {
      // Rule artifact written by EvaluatorRunner.succeedTask (PRI-427) when
      // adversarialResult.passed === true. Resolve it from the store.
      const ruleArtifactId = await resolveRuleArtifactId(input, resolvedEvaluatorTaskId);
      if (!ruleArtifactId) {
        return rejected(round, resolvedEvaluatorTaskId, lastPrincipleArtifactId, lastAdversarialResult,
          'evaluator_approved_without_rule_artifact');
      }
      return {
        decision: 'approved',
        rounds: round,
        finalEvaluatorTaskId: resolvedEvaluatorTaskId,
        ruleArtifactId,
        principleArtifactId: lastPrincipleArtifactId,
        adversarialResult: lastAdversarialResult,
      };
    }

    if (decision === 'rejected') {
      return {
        decision: 'rejected',
        rounds: round,
        finalEvaluatorTaskId: resolvedEvaluatorTaskId,
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

function planExistingSuccessorTask(
  task: TaskRecord,
  taskKind: 'artificer' | 'evaluator',
): LoopSuccessorPlan {
  const { status } = task;
  if (status === 'succeeded') return { action: 'recover', task, creationOutcome: 'existing' };
  if (status === 'pending' || status === 'retry_wait') {
    return { action: 'execute', task, creationOutcome: 'existing' };
  }
  if (status === 'leased') return { action: 'blocked', reason: `${taskKind}_successor_leased_active`, task };
  if (status === 'failed') return { action: 'blocked', reason: `${taskKind}_successor_failed_terminal`, task };
  if (status === 'needs_human_review') return { action: 'blocked', reason: `${taskKind}_successor_needs_human_review`, task };
  return { action: 'blocked', reason: `${taskKind}_successor_unknown_status:${status}`, task };
}

function commitTransitionDetail(commit: CommitNextTaskResult): string {
  const reasonValue: unknown = Reflect.get(commit, 'reason');
  if (typeof reasonValue === 'string' && reasonValue !== '') return `:${reasonValue}`;
  const detailValue: unknown = Reflect.get(commit, 'detail');
  return typeof detailValue === 'string' && detailValue !== '' ? `:${detailValue}` : '';
}

type EvaluatorRevisionRoundResolution =
  | { readonly kind: 'plain' }
  | { readonly kind: 'revision'; readonly round: number }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Resolve the logical adversarial round of a reopened evaluator from durable
 * repair lineage. The reopen path intentionally preserves the original
 * evaluator task id and parent, so positional lookup alone cannot tell a
 * first evaluation from a repair revision resumption.
 */
async function resolveEvaluatorRevisionRound(
  stateManager: RuntimeStateManager,
  evaluatorPi: PITaskRecord,
): Promise<EvaluatorRevisionRoundResolution> {
  let artificerDependencyCount = 0;
  let malformedArtificerMetadata = false;
  let repairPayload: PITaskRecord['repairPayload'] | undefined;
  for (const dependencyTaskId of evaluatorPi.dependencyTaskIds) {
    const dependency = await stateManager.getTask(dependencyTaskId);
    if (!dependency || dependency.taskKind !== 'artificer') continue;
    artificerDependencyCount += 1;
    const dependencyPi = hydratePITaskRecord(dependency);
    if (!dependencyPi) malformedArtificerMetadata = true;
    if (dependencyPi) {
      const { repairPayload: dependencyRepairPayload } = dependencyPi;
      if (dependencyRepairPayload) repairPayload = dependencyRepairPayload;
    }
  }
  if (malformedArtificerMetadata) {
    return { kind: 'invalid', reason: 'evaluator_revision_round_artificer_metadata_malformed' };
  }
  if (artificerDependencyCount === 0) return { kind: 'plain' };
  if (artificerDependencyCount !== 1) {
    return { kind: 'invalid', reason: 'evaluator_revision_round_ambiguous_artificer_dependencies' };
  }
  if (!repairPayload) return { kind: 'plain' };
  if (repairPayload.sourceEvaluatorTaskId !== evaluatorPi.taskId) {
    return { kind: 'invalid', reason: 'evaluator_revision_round_repair_source_mismatch' };
  }
  return { kind: 'revision', round: repairPayload.repairIteration + 1 };
}

async function enforceEvaluatorRevisionRound(input: {
  readonly stateManager: RuntimeStateManager;
  readonly evaluatorPi: PITaskRecord;
  readonly currentRound: number;
  readonly maxRounds: number;
  readonly willExecute: boolean;
}): Promise<{ readonly kind: 'ok'; readonly round: number } | { readonly kind: 'invalid'; readonly reason: string }> {
  const revisionRound = await resolveEvaluatorRevisionRound(input.stateManager, input.evaluatorPi);
  if (revisionRound.kind === 'invalid') return revisionRound;
  if (revisionRound.kind === 'plain') return { kind: 'ok', round: input.currentRound };
  if (input.willExecute && revisionRound.round > input.maxRounds) {
    return {
      kind: 'invalid',
      reason: `max_rounds_exhausted_before_revision_round_${revisionRound.round}`,
    };
  }
  // The reopened evaluator keeps its original task id and parent. Its durable
  // repair dependency is therefore the only truthful carrier of the logical
  // adversarial round after a restart; positional loop lookup alone would
  // restart that second evaluation as "round 1".
  return { kind: 'ok', round: Math.max(input.currentRound, revisionRound.round) };
}

async function applyFormalSuccessorCascade(input: {
  readonly stateManager: RuntimeStateManager;
  readonly commitTaskTransition: ((taskId: string) => Promise<CommitNextTaskResult>) | undefined;
  readonly sourceTaskId: string;
  readonly successorTask: TaskRecord;
}): Promise<LoopSuccessorPlan> {
  if (!input.commitTaskTransition) {
    return { action: 'blocked', reason: 'evaluator_cascade_transition_authority_missing' };
  }
  const commit = await input.commitTaskTransition(input.sourceTaskId);
  const commitSourceTaskId: unknown = Reflect.get(commit, 'sourceTaskId');
  if (commitSourceTaskId === undefined) {
    return {
      action: 'blocked',
      reason: `evaluator_cascade_transition_${commit.decision}${commitTransitionDetail(commit)}`,
    };
  }
  if (commitSourceTaskId !== input.sourceTaskId) {
    return { action: 'blocked', reason: 'evaluator_cascade_transition_source_task_mismatch' };
  }

  let cascadeTargetTaskId: string;
  if (commit.decision === 'successor_reopened' || commit.decision === 'revision_reopen_noop') {
    cascadeTargetTaskId = commit.reopenedTaskId;
  } else {
    return {
      action: 'blocked',
      reason: `evaluator_cascade_transition_${commit.decision}${commitTransitionDetail(commit)}`,
    };
  }
  if (cascadeTargetTaskId !== input.successorTask.taskId) {
    return { action: 'blocked', reason: 'evaluator_cascade_transition_target_mismatch' };
  }
  const currentSuccessor = await input.stateManager.getTask(cascadeTargetTaskId);
  if (!currentSuccessor) {
    return { action: 'blocked', reason: 'evaluator_cascade_transition_target_missing' };
  }
  return planExistingSuccessorTask(currentSuccessor, 'evaluator');
}

async function createLoopSuccessorTask(
  stateManager: RuntimeStateManager,
  input: {
    readonly preferredTaskId: string;
    readonly taskKind: 'artificer' | 'evaluator';
    readonly parentTaskId: string;
    readonly channel: 'prompt' | 'code_tool_hook' | 'defer_archive';
    readonly metadata: Parameters<typeof createPITaskDiagnosticJson>[0];
  },
): Promise<LoopSuccessorPlan> {
  const creation = await createLogicalSuccessorTask({
    stateManager,
    parentTaskId: input.parentTaskId,
    successorKind: input.taskKind,
    channel: input.channel,
    preferredTaskId: input.preferredTaskId,
    metadata: input.metadata,
  });
  if (creation.outcome === 'created') {
    return { action: 'execute', task: creation.task, creationOutcome: 'created' };
  }
  if (creation.outcome === 'existing') {
    return planExistingSuccessorTask(creation.task, input.taskKind);
  }
  if (creation.outcome === 'lookup') {
    return { action: 'blocked', reason: `${input.taskKind}_successor_lookup_${creation.lookup.decision}:${creation.lookup.detail}` };
  }
  return { action: 'blocked', reason: `${input.taskKind}_successor_id_conflict:${creation.allocation.detail}` };
}

// eslint-disable-next-line @typescript-eslint/max-params
async function createEvaluatorTask(
  stateManager: RuntimeStateManager,
  evaluatorTaskId: string,
  artificerTaskId: string,
  channel: 'prompt' | 'code_tool_hook' | 'defer_archive',
): Promise<LoopSuccessorPlan> {
  return createLoopSuccessorTask(stateManager, {
    preferredTaskId: evaluatorTaskId,
    taskKind: 'evaluator',
    parentTaskId: artificerTaskId,
    channel,
    metadata: {
      dependencyTaskIds: [artificerTaskId],
      channel,
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      // PRI-1293 review fix: the evaluator's causal parent is the same-round
      // artificer — without it the parentTaskId chain breaks here and repair
      // seeding is refused for legitimate synchronous evaluations.
      parentTaskId: artificerTaskId,
    },
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
