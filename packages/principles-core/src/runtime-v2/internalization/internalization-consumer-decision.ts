import type { RunnerKind } from './peer-runner-contracts.js';

export const DEFAULT_CONSUMER_MAX_TASKS_PER_CYCLE = 1;
export const DEFAULT_CONSUMER_RUNNER_KINDS: readonly RunnerKind[] = ['dreamer'] as const;

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
}

export function computeConsumerDecision(input: ConsumerDecisionInput): ConsumerDecision {
  const maxTasks = input.maxTasksPerCycle ?? DEFAULT_CONSUMER_MAX_TASKS_PER_CYCLE;

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
      runnerKinds: DEFAULT_CONSUMER_RUNNER_KINDS,
      reason: 'no_ready_tasks',
    };
  }

  return {
    shouldConsume: true,
    maxTasksPerCycle: Math.min(maxTasks, input.readyTaskCount),
    runnerKinds: DEFAULT_CONSUMER_RUNNER_KINDS,
  };
}
