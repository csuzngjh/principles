/**
 * Queue Actionability Policy — PRI-253
 *
 * Pure classification: is a given internalization task actionable
 * for the current MVP release, or should it be suppressed from the
 * operator-actionable queue?
 *
 * I/O boundary: enabledChannels and actionableTaskKinds are provided
 * by the caller (pd-cli via feature flags). This module never reads
 * files or loads configuration.
 */

import type { RunnerKind, PeerRunnerKind, InternalizationChannel } from './peer-runner-contracts.js';

// ── MVP-Core task kinds ──────────────────────────────────────────────────────

/**
 * Task kinds considered operator-actionable: visible as `ready` (not
 * `suppressed`) in the queue snapshot and counted toward `readyTaskCount`.
 *
 * `rollout_reviewer` is included so operators can see pending rollout-review
 * tasks and advance them manually (`pd runtime internalization run-once
 * --runner rollout_reviewer`). It is NOT auto-consumed — the auto-consumer's
 * execution scope is governed independently by FULL_CHAIN_CONSUMER_RUNNER_KINDS
 * (internalization-consumer-decision.ts), which deliberately excludes it,
 * keeping rollout review as the last manual Owner gate before approval.
 */
export const MVP_CORE_TASK_KINDS: readonly PeerRunnerKind[] = [
  'dreamer',
  'philosopher',
  'scribe',
  'artificer',
  'evaluator',
  'rollout_reviewer',
] as const;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActionabilityPolicyInput {
  enabledChannels: Set<string>;
  actionableTaskKinds: Set<string>;
}

export interface SuppressedDiagnostic {
  taskId: string;
  taskKind: RunnerKind;
  channel: InternalizationChannel;
  reason: 'channel_disabled' | 'task_kind_not_mvp_actionable';
}

export type TaskActionabilityResult =
  | { actionable: true }
  | { actionable: false; reason: 'channel_disabled' | 'task_kind_not_mvp_actionable'; diagnostic: SuppressedDiagnostic };

export interface TaskClassificationInput {
  taskId: string;
  taskKind: RunnerKind;
  channel: InternalizationChannel;
}

// ── Pure classifier ──────────────────────────────────────────────────────────

export function classifyTaskActionability(
  task: TaskClassificationInput,
  policy: ActionabilityPolicyInput,
): TaskActionabilityResult {
  // Channel check first — if the channel is disabled, the task cannot execute
  if (!policy.enabledChannels.has(task.channel)) {
    return {
      actionable: false,
      reason: 'channel_disabled',
      diagnostic: {
        taskId: task.taskId,
        taskKind: task.taskKind,
        channel: task.channel,
        reason: 'channel_disabled',
      },
    };
  }

  // TaskKind check — post-MVP runners are not operator-actionable for first customer
  if (!policy.actionableTaskKinds.has(task.taskKind)) {
    return {
      actionable: false,
      reason: 'task_kind_not_mvp_actionable',
      diagnostic: {
        taskId: task.taskId,
        taskKind: task.taskKind,
        channel: task.channel,
        reason: 'task_kind_not_mvp_actionable',
      },
    };
  }

  return { actionable: true };
}
