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

import type { PeerRunnerKind, InternalizationChannel } from './peer-runner-contracts.js';

// ── MVP-Core task kinds ──────────────────────────────────────────────────────

export const MVP_CORE_TASK_KINDS: readonly PeerRunnerKind[] = [
  'dreamer',
  'philosopher',
  'scribe',
  'artificer',
] as const;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActionabilityPolicyInput {
  enabledChannels: Set<string>;
  actionableTaskKinds: Set<string>;
}

export interface SuppressedDiagnostic {
  taskId: string;
  taskKind: PeerRunnerKind;
  channel: InternalizationChannel;
  reason: 'channel_disabled' | 'task_kind_not_mvp_actionable';
}

export type TaskActionabilityResult =
  | { actionable: true }
  | { actionable: false; reason: 'channel_disabled' | 'task_kind_not_mvp_actionable'; diagnostic: SuppressedDiagnostic };

export interface TaskClassificationInput {
  taskId: string;
  taskKind: PeerRunnerKind;
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
