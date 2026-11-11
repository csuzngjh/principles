/**
 * Trajectory retention trigger for the OpenClaw plugin (SPEC-PD-TR-001 §4.1).
 *
 * Mirrors `product-telemetry-trigger.ts`: the long-lived gateway process gets
 * one unref'd interval per workspace, scheduled from the same per-workspace
 * one-time init that already runs inside `before_prompt_build`. Nothing runs at
 * scheduling time, so the hook pays only a `path.resolve` + timer setup.
 */

import { scheduleTrajectoryRetention } from '@principles/host-runtime';

export interface TrajectoryRetentionTriggerLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export function scheduleTrajectoryRetentionForWorkspace(
  workspaceDir: string,
  logger?: TrajectoryRetentionTriggerLogger,
): void {
  scheduleTrajectoryRetention(workspaceDir, logger);
}
