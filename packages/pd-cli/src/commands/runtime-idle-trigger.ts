import * as path from 'path';
import {
  RuntimeStateManager,
  InternalizationQueueReadModel,
  evaluateIdleTriggerDecision,
  resolveIdleTriggerConfig,
} from '@principles/core/runtime-v2';
import type { IdleTriggerResult, IdleTriggerConfig } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface IdleTriggerEvaluateOptions {
  workspace?: string;
  json?: boolean;
  enabled?: boolean;
  idleThresholdMs?: number;
  jitterMaxMs?: number;
  activityCooldownMs?: number;
  jitterSeed?: string;
}

function formatTextOutput(result: IdleTriggerResult): string {
  const lines: string[] = [];
  lines.push(`IdleTrigger: ${result.decision}`);
  lines.push(`  reason: ${result.reason}`);
  lines.push(`  idleForMs: ${result.idleForMs}`);
  lines.push(`  jitterMs: ${result.jitterMs}`);
  lines.push(`  nextEligibleAt: ${result.nextEligibleAt}`);
  lines.push(`  queue: ready=${result.queue.readyCount} pending=${result.queue.pendingCount} retryWait=${result.queue.retryWaitCount}`);
  return lines.join('\n');
}

async function findLastActivityAt(stateManager: RuntimeStateManager): Promise<string | null> {
  try {
    const tasks = await stateManager.listTasks({});
    if (tasks.length === 0) return null;
    let latest: string | null = null;
    for (const task of tasks) {
      const ts = task.updatedAt ?? task.createdAt;
      if (ts && (!latest || ts > latest)) {
        latest = ts;
      }
    }
    return latest;
  } catch {
    return null;
  }
}

export async function handleRuntimeIdleTriggerEvaluate(opts: IdleTriggerEvaluateOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();

  const configOverrides: Partial<IdleTriggerConfig> = {};
  if (opts.enabled !== undefined) configOverrides.enabled = opts.enabled;
  if (opts.idleThresholdMs !== undefined) configOverrides.idleThresholdMs = opts.idleThresholdMs;
  if (opts.jitterMaxMs !== undefined) configOverrides.jitterMaxMs = opts.jitterMaxMs;
  if (opts.activityCooldownMs !== undefined) configOverrides.activityCooldownMs = opts.activityCooldownMs;
  const config = resolveIdleTriggerConfig(configOverrides);

  const jitterSeed = opts.jitterSeed ?? `idle-trigger-${Date.now()}`;

  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    const queueReadModel = new InternalizationQueueReadModel(stateManager);
    const snapshot = await queueReadModel.getSnapshot();

    const lastActivityAt = await findLastActivityAt(stateManager);

    const result = evaluateIdleTriggerDecision({
      lastActivityAt,
      queue: {
        readyCount: snapshot.readyTasks.length,
        pendingCount: snapshot.pendingCount,
        retryWaitCount: snapshot.retryWaitCount,
      },
      config,
      jitterSeed,
      now: new Date().toISOString(),
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTextOutput(result));
    }

    if (result.decision === 'skip') {
      process.exitCode = 1;
    }
  } finally {
    await stateManager.close();
  }
}
