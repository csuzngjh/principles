import type { RunnerKind } from './peer-runner-contracts.js';

export const DEFAULT_CONSUMER_MAX_TASKS_PER_CYCLE = 1;

/**
 * Auto-consume scope when the `internalization_full_chain` flag is OFF.
 * Dreamer-only (PRI-419 original scope). Kept as the rollback default so
 * disabling the flag immediately restores the prior behavior.
 */
export const DEFAULT_CONSUMER_RUNNER_KINDS: readonly RunnerKind[] = ['dreamer'] as const;

/**
 * Auto-consume scope when the `internalization_full_chain` flag is ON.
 * Advances dreamer → philosopher → scribe → artificer → evaluator →
 * rollout_reviewer so artifacts reach `validation_status='validated'` and the
 * rollout review completes unattended.
 *
 * `rollout_reviewer` is an AI review step, NOT a human gate — the human gate
 * is the approval queue (Owner approves/rejects in the Console). Requiring a
 * manual CLI trigger before the Console gate dead-ended non-technical Owners
 * (principle stuck at "数据暂不可用" with no actionable path). Manual
 * advancement via `pd runtime internalization run-once --runner rollout_reviewer`
 * is unaffected (run-once bypasses actionability).
 */
export const FULL_CHAIN_CONSUMER_RUNNER_KINDS: readonly RunnerKind[] = [
  'dreamer',
  'philosopher',
  'scribe',
  'artificer',
  'evaluator',
  'rollout_reviewer',
] as const;

export interface ConsumerDecision {
  shouldConsume: boolean;
  maxTasksPerCycle: number;
  runnerKinds: readonly RunnerKind[];
  reason?: string;
  nextAction?: string;
}

export interface ConsumerDecisionInput {
  autoConsumerEnabled: boolean;
  readyTaskCount: number;
  maxTasksPerCycle?: number;
  /**
   * Override the auto-consume runner-kind scope. When omitted, falls back to
   * DEFAULT_CONSUMER_RUNNER_KINDS (dreamer-only). The auto-consumer service
   * resolves this from the `internalization_full_chain` flag:
   *   flag ON  → FULL_CHAIN_CONSUMER_RUNNER_KINDS
   *   flag OFF → DEFAULT_CONSUMER_RUNNER_KINDS
   */
  runnerKinds?: readonly RunnerKind[];
}

export function computeConsumerDecision(input: ConsumerDecisionInput): ConsumerDecision {
  const maxTasks = input.maxTasksPerCycle ?? DEFAULT_CONSUMER_MAX_TASKS_PER_CYCLE;
  const runnerKinds = input.runnerKinds ?? DEFAULT_CONSUMER_RUNNER_KINDS;

  if (!input.autoConsumerEnabled) {
    return {
      shouldConsume: false,
      maxTasksPerCycle: 0,
      runnerKinds: [],
      reason: 'auto_consumer_disabled',
      nextAction:
        'pd runtime internalization run-once --workspace "<workspace>" --runner dreamer --runtime config --json',
    };
  }

  if (input.readyTaskCount === 0) {
    return {
      shouldConsume: false,
      maxTasksPerCycle: maxTasks,
      runnerKinds,
      reason: 'no_ready_tasks',
    };
  }

  return {
    shouldConsume: true,
    maxTasksPerCycle: Math.min(maxTasks, input.readyTaskCount),
    runnerKinds,
  };
}
